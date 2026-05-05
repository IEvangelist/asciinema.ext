import * as vscode from "vscode";
import {
    parsePullRequestUrl,
    type PullRequestCoordinates,
} from "./parse-pr-url.js";
import {
    parseActionsRunUrl,
    type ActionsRunCoordinates,
} from "./parse-run-url.js";
import {
    findRunWithArtifacts,
    getGitHubSession,
    getPullRequestHead,
    getWorkflowRunById,
    listArtifactsForRun,
    type WorkflowArtifact,
    type WorkflowRunSummary,
} from "./github-client.js";
import { dispatchHandler } from "./artifact-handlers/dispatcher.js";
import type { HandlerContext } from "./artifact-handlers/handler-types.js";
import {
    conclusionIcon,
    formatBytesShort,
    formatRelativeTime,
} from "./quickpick-helpers.js";
import {
    listRecent,
    removeRecent,
    type RecentArtifact,
} from "./recent-artifacts.js";
import {
    fromActionsRun,
    fromPullRequest,
    pullRequestUrl,
    repoOf,
} from "./artifact-source.js";
import {
    handleApiError,
    pickAndOpenArtifact,
} from "./download-and-open.js";

/**
 * Command implementation for `asciinema.openFromPullRequest`.
 *
 * Despite the name, the entry point now accepts either a GitHub PR URL or
 * an Actions run URL — the command is the central "Artifacts Explorer"
 * surface, with recents from both sources listed together.
 */
export async function openFromPullRequestCommand(
    context: vscode.ExtensionContext
): Promise<void> {
    const recent = await listRecent();
    const choice = await pickStartingPoint(recent);
    if (!choice) {
        return;
    }
    if (choice.kind === "recent") {
        await openRecent(context, choice.entry);
        return;
    }

    let rawUrl = choice.prefilledUrl;
    if (!rawUrl) {
        rawUrl = await vscode.window.showInputBox({
            title: "GitHub — Artifacts Explorer",
            prompt: "Paste a GitHub pull request or Actions run URL",
            placeHolder:
                "https://github.com/owner/repo/pull/123 — or /actions/runs/12345",
            ignoreFocusOut: true,
            validateInput: (value) =>
                !value ||
                parsePullRequestUrl(value) ||
                parseActionsRunUrl(value)
                    ? undefined
                    : "Not a recognized GitHub PR or Actions run URL",
        });
        if (!rawUrl) {
            return;
        }
    }

    const prCoords = parsePullRequestUrl(rawUrl);
    if (prCoords) {
        await runPrFlow(context, prCoords);
        return;
    }
    const runCoords = parseActionsRunUrl(rawUrl);
    if (runCoords) {
        await runActionsRunFlow(context, runCoords);
        return;
    }
    await vscode.window.showErrorMessage(
        "That doesn't look like a GitHub PR or Actions run URL."
    );
}

type StartingPointChoice =
    | { kind: "new"; prefilledUrl?: string }
    | { kind: "recent"; entry: RecentArtifact };

interface StartingPointItem extends vscode.QuickPickItem {
    readonly choice?: StartingPointChoice;
    readonly entry?: RecentArtifact;
}

const OPEN_PR_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("git-pull-request"),
    tooltip: "Open pull request on github.com",
};
const OPEN_RUN_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("link-external"),
    tooltip: "Open workflow run on github.com",
};
const FORGET_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("trash"),
    tooltip: "Forget this cached artifact (deletes from disk)",
};
const CLEAR_ALL_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("clear-all"),
    tooltip: "Forget all recent artifacts",
};
const REFRESH_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("refresh"),
    tooltip: "Refresh list",
};

/**
 * Source-aware description for a recent entry — for PR-sourced entries we
 * surface `repo + #PR`; for run-sourced entries we surface `repo + run #N`.
 */
function describeSource(entry: RecentArtifact): string {
    const repo = repoOf(entry.source);
    if (entry.source.kind === "pr") {
        return `$(repo) ${repo.owner}/${repo.repo} $(git-pull-request) #${entry.source.coords.number}`;
    }
    return `$(repo) ${repo.owner}/${repo.repo} $(github-action) run #${entry.run.runNumber}`;
}

/**
 * Buttons offered on a recent entry — `Open PR` only appears for PR-sourced
 * entries; everyone gets `Open Run` and `Forget`.
 */
function buttonsFor(entry: RecentArtifact): vscode.QuickInputButton[] {
    if (entry.source.kind === "pr") {
        return [OPEN_PR_BTN, OPEN_RUN_BTN, FORGET_BTN];
    }
    return [OPEN_RUN_BTN, FORGET_BTN];
}

function buildStartingPointItems(
    recent: readonly RecentArtifact[]
): StartingPointItem[] {
    const items: StartingPointItem[] = [];
    if (recent.length > 0) {
        items.push({
            label: `Recent artifacts (${recent.length})`,
            kind: vscode.QuickPickItemKind.Separator,
        });
        for (const entry of recent) {
            const runIcon = conclusionIcon(entry.run.conclusion);
            const workflowName = entry.run.name ?? "workflow";
            const branchLabel = entry.run.headBranch ?? "(detached)";
            const shortSha = entry.run.headSha.slice(0, 7);
            items.push({
                label: `$(history)  ${entry.artifact.name}`,
                description: `${describeSource(entry)} · ${formatBytesShort(
                    entry.artifact.sizeInBytes
                )} · ${formatRelativeTime(new Date(entry.downloadedAt).toISOString())}`,
                detail: `${runIcon} ${workflowName} #${entry.run.runNumber} · $(git-branch) ${branchLabel}@${shortSha}`,
                buttons: buttonsFor(entry),
                entry,
            });
        }
        items.push({
            label: "More",
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: "$(cloud-download)  Download from a PR or Actions run…",
            description: "Paste a PR or workflow-run URL",
            choice: { kind: "new" },
        });
    } else {
        items.push({
            label: "Get started",
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: "$(cloud-download)  Download from a PR or Actions run",
            description: "Paste a PR or workflow-run URL to fetch its artifacts",
            detail: "$(info) No recent artifacts yet — successfully opened ones will appear here for quick access.",
            choice: { kind: "new" },
        });
    }
    return items;
}

async function pickStartingPoint(
    initialRecent: readonly RecentArtifact[]
): Promise<StartingPointChoice | undefined> {
    return await new Promise<StartingPointChoice | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<StartingPointItem>();
        let recent = [...initialRecent];
        let settled = false;
        const finish = (value: StartingPointChoice | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        const refresh = () => {
            qp.items = buildStartingPointItems(recent);
            qp.buttons = recent.length > 0
                ? [REFRESH_BTN, CLEAR_ALL_BTN]
                : [REFRESH_BTN];
        };
        qp.title = "GitHub — Artifacts Explorer";
        qp.placeholder =
            recent.length > 0
                ? `Pick a recent artifact, or paste a PR / run URL to download a new one… (${recent.length} cached)`
                : "Paste a GitHub PR or Actions run URL to download an artifact…";
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.ignoreFocusOut = true;
        refresh();

        qp.onDidTriggerButton(async (btn) => {
            if (btn === REFRESH_BTN) {
                recent = await listRecent();
                refresh();
            } else if (btn === CLEAR_ALL_BTN) {
                const confirm = await vscode.window.showWarningMessage(
                    `Forget all ${recent.length} recent artifacts? Their cached files will be deleted.`,
                    { modal: true },
                    "Forget All"
                );
                if (confirm === "Forget All") {
                    for (const e of recent) {
                        await removeRecent(e.key);
                    }
                    recent = [];
                    refresh();
                }
            }
        });
        qp.onDidTriggerItemButton(async (e) => {
            const entry = e.item.entry;
            if (!entry) {
                return;
            }
            if (e.button === OPEN_PR_BTN && entry.source.kind === "pr") {
                void vscode.env.openExternal(
                    vscode.Uri.parse(pullRequestUrl(entry.source.coords))
                );
            } else if (e.button === OPEN_RUN_BTN) {
                void vscode.env.openExternal(vscode.Uri.parse(entry.run.htmlUrl));
            } else if (e.button === FORGET_BTN) {
                await removeRecent(entry.key);
                recent = recent.filter((it) => it.key !== entry.key);
                refresh();
            }
        });
        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            const typed = qp.value.trim();
            qp.hide();
            if (picked?.entry) {
                finish({ kind: "recent", entry: picked.entry });
                return;
            }
            if (picked?.choice) {
                if (
                    picked.choice.kind === "new" &&
                    typed &&
                    (parsePullRequestUrl(typed) || parseActionsRunUrl(typed))
                ) {
                    finish({ kind: "new", prefilledUrl: typed });
                } else {
                    finish(picked.choice);
                }
                return;
            }
            // No item matched — if the typed value parses as a known URL,
            // route straight into the download flow.
            if (
                typed &&
                (parsePullRequestUrl(typed) || parseActionsRunUrl(typed))
            ) {
                finish({ kind: "new", prefilledUrl: typed });
                return;
            }
            finish(undefined);
        });
        qp.onDidHide(() => {
            qp.dispose();
            finish(undefined);
        });
        qp.show();
    });
}

async function openRecent(
    context: vscode.ExtensionContext,
    entry: RecentArtifact
): Promise<void> {
    const handlerCtx: HandlerContext = {
        extensionContext: context,
        coords: repoOf(entry.source),
        run: entry.run,
        artifact: entry.artifact,
        extracted: entry.extracted,
    };
    await dispatchHandler(handlerCtx);
}

async function runPrFlow(
    context: vscode.ExtensionContext,
    coords: PullRequestCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;
    const prUrl = pullRequestUrl(coords);

    let head: Awaited<ReturnType<typeof getPullRequestHead>>;
    try {
        head = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Asciinema — Looking up ${coords.owner}/${coords.repo}#${coords.number}`,
            },
            () => getPullRequestHead(token, coords)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: `Couldn't access pull request ${coords.owner}/${coords.repo}#${coords.number}.`,
            fallbackLabel: "Open PR in Browser",
            fallbackUrl: prUrl,
            retry: () => runPrFlow(context, coords),
        });
        return;
    }

    let runAndArtifacts:
        | { run: WorkflowRunSummary; artifacts: WorkflowArtifact[] }
        | undefined;
    try {
        runAndArtifacts = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Asciinema — Finding CI run with artifacts",
            },
            () => findRunWithArtifacts(token, coords, head.sha)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to query workflow runs.",
            fallbackLabel: "Open PR in Browser",
            fallbackUrl: head.htmlUrl,
            retry: () => runPrFlow(context, coords),
        });
        return;
    }

    if (!runAndArtifacts) {
        const choice = await vscode.window.showErrorMessage(
            `No completed workflow run with artifacts found for commit ${head.sha.slice(
                0,
                7
            )} on PR #${coords.number}.`,
            "Open PR in Browser"
        );
        if (choice === "Open PR in Browser") {
            await vscode.env.openExternal(vscode.Uri.parse(head.htmlUrl));
        }
        return;
    }

    const { run, artifacts } = runAndArtifacts;
    await pickAndOpenArtifact(
        context,
        fromPullRequest(coords),
        run,
        artifacts,
        {
            fallbackLabel: "Open PR in Browser",
            fallbackUrl: head.htmlUrl,
        }
    );
}

async function runActionsRunFlow(
    context: vscode.ExtensionContext,
    coords: ActionsRunCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;
    const repo = { owner: coords.owner, repo: coords.repo };
    const runUrl = `https://github.com/${coords.owner}/${coords.repo}/actions/runs/${coords.runId}`;

    let run: WorkflowRunSummary;
    try {
        run = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Asciinema — Looking up run ${coords.owner}/${coords.repo} #${coords.runId}`,
            },
            () => getWorkflowRunById(token, repo, coords.runId)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: `Couldn't access run ${coords.owner}/${coords.repo} #${coords.runId}.`,
            fallbackLabel: "Open Run in Browser",
            fallbackUrl: runUrl,
            retry: () => runActionsRunFlow(context, coords),
        });
        return;
    }

    let artifacts: WorkflowArtifact[];
    try {
        artifacts = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Asciinema — Listing artifacts for run",
            },
            () => listArtifactsForRun(token, repo, coords.runId)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to list artifacts for this run.",
            fallbackLabel: "Open Run in Browser",
            fallbackUrl: run.htmlUrl,
            retry: () => runActionsRunFlow(context, coords),
        });
        return;
    }

    if (artifacts.length === 0) {
        const inProgress =
            run.conclusion === null &&
            run.status !== null &&
            run.status !== "completed";
        const message = inProgress
            ? `Run "${run.name ?? "workflow"}" #${run.runNumber} is still ${run.status ?? "in progress"} — no artifacts uploaded yet.`
            : `No non-expired artifacts found for run "${run.name ?? "workflow"}" #${run.runNumber}.`;
        const choice = await vscode.window.showWarningMessage(
            message,
            "Open Run in Browser"
        );
        if (choice === "Open Run in Browser") {
            await vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl));
        }
        return;
    }

    await pickAndOpenArtifact(
        context,
        fromActionsRun(coords),
        run,
        artifacts,
        {
            fallbackLabel: "Open Run in Browser",
            fallbackUrl: run.htmlUrl,
        }
    );
}

async function acquireSession(): Promise<
    vscode.AuthenticationSession | undefined
> {
    const existing = await getGitHubSession(false);
    if (existing) {
        return existing;
    }
    const session = await getGitHubSession(true);
    if (session) {
        return session;
    }
    const choice = await vscode.window.showErrorMessage(
        "GitHub sign-in is required to download CI artifacts.",
        "Sign in"
    );
    if (choice === "Sign in") {
        return await getGitHubSession(true);
    }
    return undefined;
}

// Re-exports preserved so existing imports continue to resolve.
export type { ArtifactSource } from "./artifact-source.js";
