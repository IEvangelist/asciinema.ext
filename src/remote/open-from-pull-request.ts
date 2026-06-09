import * as vscode from "vscode";
import {
    parsePullRequestUrl,
} from "./parse-pr-url.js";
import {
    parseActionsRunUrl,
} from "./parse-run-url.js";
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
    pullRequestUrl,
    repoOf,
} from "./artifact-source.js";
import { parseRepositoryUrl } from "./parse-repo-url.js";
import { deleteArtifactCache } from "./temp-storage.js";
import { runActionsRunFlow } from "./actions-run-flow.js";
import { runExploreRepositoryFlow } from "./explore-repository-flow.js";
import { runPrFlow } from "./pr-flow.js";
import {
    confirmPalette,
    showPaletteNotice,
} from "./quick-input.js";

/**
 * Command implementation for `asciinema.openFromPullRequest`.
 *
 * Despite the name, the entry point now accepts either a GitHub PR URL or
 * an Actions run URL or a repository URL — the command is the central
 * "Artifacts Explorer"
 * surface, with recents from both sources listed together.
 */
export interface OpenFromPullRequestOptions {
    readonly prefilledUrl?: string;
}

export async function openFromPullRequestCommand(
    context: vscode.ExtensionContext,
    options: OpenFromPullRequestOptions = {}
): Promise<void> {
    const choice = options.prefilledUrl
        ? ({ kind: "new", prefilledUrl: options.prefilledUrl } as const)
        : await pickStartingPoint(await listRecent());
    if (!choice) {
        return;
    }
    if (choice.kind === "recent") {
        await openRecent(context, choice.entry);
        return;
    }
    if (choice.kind === "clear-all-recents") {
        await clearAllRecentsFromPicker();
        await openFromPullRequestCommand(context);
        return;
    }

    let rawUrl = choice.prefilledUrl;
    if (!rawUrl) {
        rawUrl = await vscode.window.showInputBox({
            title: "GitHub Artifacts — Explorer",
            prompt: "Paste a GitHub pull request, Actions run, or repository URL",
            placeHolder:
                "https://github.com/owner/repo/pull/123 — or /actions/runs/12345 — or /owner/repo",
            ignoreFocusOut: true,
            validateInput: (value) =>
                !value ||
                parsePullRequestUrl(value) ||
                parseActionsRunUrl(value) ||
                parseRepositoryUrl(value)
                    ? undefined
                    : "Not a recognized GitHub PR, Actions run, or repository URL",
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
    const repoCoords = parseRepositoryUrl(rawUrl);
    if (repoCoords) {
        await runExploreRepositoryFlow(context, repoCoords);
        return;
    }
    await showPaletteNotice(
        "GitHub Artifacts — URL not recognized",
        "That doesn't look like a GitHub PR, Actions run, or repository URL.",
        "error"
    );
}

type StartingPointChoice =
    | { kind: "new"; prefilledUrl?: string }
    | { kind: "recent"; entry: RecentArtifact }
    | { kind: "clear-all-recents" };

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
            label: "$(clear-all)  Forget all recent artifacts",
            description: "Delete cached files for every recent entry",
            choice: { kind: "clear-all-recents" },
        });
        items.push({
            label: "$(cloud-download)  Open from a PR, Actions run, or repository…",
            description: "Paste a PR, workflow-run, or repository URL",
            choice: { kind: "new" },
        });
    } else {
        items.push({
            label: "Get started",
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: "$(cloud-download)  Open from a PR, Actions run, or repository",
            description: "Paste a PR, workflow-run, or repository URL",
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
        qp.title = "GitHub Artifacts — Explorer";
        qp.placeholder =
            recent.length > 0
                ? `Pick a recent artifact, or paste a PR / run / repository URL… (${recent.length} cached)`
                : "Paste a GitHub PR, Actions run, or repository URL…";
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.ignoreFocusOut = true;
        refresh();

        qp.onDidTriggerButton(async (btn) => {
            if (btn === REFRESH_BTN) {
                recent = await listRecent();
                refresh();
            } else if (btn === CLEAR_ALL_BTN) {
                finish({ kind: "clear-all-recents" });
                qp.hide();
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
            if (picked?.entry) {
                finish({ kind: "recent", entry: picked.entry });
                qp.hide();
                return;
            }
            if (picked?.choice) {
                if (
                    picked.choice.kind === "new" &&
                    typed &&
                    (
                        parsePullRequestUrl(typed) ||
                        parseActionsRunUrl(typed) ||
                        parseRepositoryUrl(typed)
                    )
                ) {
                    finish({ kind: "new", prefilledUrl: typed });
                } else {
                    finish(picked.choice);
                }
                qp.hide();
                return;
            }
            // No item matched — if the typed value parses as a known URL,
            // route straight into the download flow.
            if (
                typed &&
                (
                    parsePullRequestUrl(typed) ||
                    parseActionsRunUrl(typed) ||
                    parseRepositoryUrl(typed)
                )
            ) {
                finish({ kind: "new", prefilledUrl: typed });
                qp.hide();
                return;
            }
            finish(undefined);
            qp.hide();
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
    let bundle;
    if (entry.kind === "zip") {
        bundle = entry.bundle;
    } else {
        // Legacy "extracted" recent — synthesize a minimal bundle so the
        // dispatcher's bundle-based detection still works. We point
        // `zipPath` at the (non-existent) cached zip URI; the dispatcher
        // never reads it because handlers operate against the existing
        // `ctx.extracted`.
        bundle = {
            zipPath: vscode.Uri.joinPath(
                context.globalStorageUri,
                "remote-artifacts",
                `${entry.artifact.id}.zip`
            ),
            files: entry.extracted.files,
            zipSizeBytes: 0,
        };
    }
    const handlerCtx: HandlerContext = {
        extensionContext: context,
        coords: repoOf(entry.source),
        run: entry.run,
        artifact: entry.artifact,
        bundle,
        extracted: entry.kind === "extracted" ? entry.extracted : undefined,
        deleteArtifactCache: async () => {
            await removeRecent(entry.key);
            await deleteArtifactCache(context, entry.artifact.id);
        },
    };
    await dispatchHandler(handlerCtx);
}

async function clearAllRecentsFromPicker(): Promise<void> {
    const recent = await listRecent();
    if (recent.length === 0) {
        await showPaletteNotice(
            "GitHub Artifacts — recents",
            "No recent artifacts to forget."
        );
        return;
    }
    const confirmed = await confirmPalette(
        "GitHub Artifacts — forget all recents",
        `Forget all ${recent.length} recent artifacts? Their cached files will be deleted.`,
        "Forget All"
    );
    if (!confirmed) {
        return;
    }
    for (const e of recent) {
        await removeRecent(e.key);
    }
    await showPaletteNotice(
        "GitHub Artifacts — recents cleared",
        `Forgot ${recent.length} recent ${recent.length === 1 ? "artifact" : "artifacts"}.`
    );
}

// Re-exports preserved so existing imports continue to resolve.
export type { ArtifactSource } from "./artifact-source.js";
