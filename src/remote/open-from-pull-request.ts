import * as vscode from "vscode";
import {
    parsePullRequestUrl,
    type PullRequestCoordinates,
} from "./parse-pr-url.js";
import {
    GitHubApiError,
    downloadArtifactZip,
    findRunWithArtifacts,
    getGitHubSession,
    getPullRequestHead,
    type WorkflowArtifact,
    type WorkflowRunSummary,
} from "./github-client.js";
import { ZipLimitError } from "./artifact-zip.js";
import { extractArtifactToDisk } from "./temp-storage.js";
import {
    DEFAULT_DISK_LIMITS,
    type DiskExtractionLimits,
} from "./zip-extract.js";
import { dispatchHandler } from "./artifact-handlers/dispatcher.js";
import type { HandlerContext } from "./artifact-handlers/handler-types.js";
import {
    conclusionIcon,
    formatBytesShort,
    formatRelativeTime,
} from "./quickpick-helpers.js";
import { showQuickPick } from "./artifact-handlers/quickpick.js";
import { getDownloadQuip, getExtractionQuip } from "./download-quips.js";
import {
    listRecent,
    recordRecent,
    removeRecent,
    type RecentArtifact,
} from "./recent-artifacts.js";

const DEFAULT_MAX_ARTIFACT_MB = 250;
const DEFAULT_MAX_EXTRACTED_MB = 2048;
const DEFAULT_MAX_ENTRY_COUNT = 250_000;
const DEFAULT_MAX_ENTRY_SIZE_MB = 500;
const HARD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB safety ceiling

function getConfiguredMaxArtifactBytes(): number {
    const mb = vscode.workspace
        .getConfiguration("asciinema")
        .get<number>("maxArtifactSizeMB", DEFAULT_MAX_ARTIFACT_MB);
    const safe = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_ARTIFACT_MB;
    return Math.round(safe * 1024 * 1024);
}

function getDiskExtractionLimits(): DiskExtractionLimits {
    const cfg = vscode.workspace.getConfiguration("asciinema");
    const totalMb = cfg.get<number>(
        "maxArtifactExtractedMB",
        DEFAULT_MAX_EXTRACTED_MB
    );
    const entryCount = cfg.get<number>(
        "maxArtifactEntryCount",
        DEFAULT_MAX_ENTRY_COUNT
    );
    const entryMb = cfg.get<number>(
        "maxArtifactEntrySizeMB",
        DEFAULT_MAX_ENTRY_SIZE_MB
    );
    const safeTotal =
        Number.isFinite(totalMb) && totalMb > 0
            ? totalMb
            : DEFAULT_MAX_EXTRACTED_MB;
    const safeCount =
        Number.isFinite(entryCount) && entryCount > 0
            ? Math.floor(entryCount)
            : DEFAULT_MAX_ENTRY_COUNT;
    const safeEntry =
        Number.isFinite(entryMb) && entryMb > 0
            ? entryMb
            : DEFAULT_MAX_ENTRY_SIZE_MB;
    return {
        maxEntries: safeCount,
        maxEntryBytes: Math.round(safeEntry * 1024 * 1024),
        maxTotalBytes: Math.round(safeTotal * 1024 * 1024),
    };
}

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
            prompt: "Paste a GitHub pull request URL",
            placeHolder: "https://github.com/owner/repo/pull/123",
            ignoreFocusOut: true,
            validateInput: (value) =>
                !value || parsePullRequestUrl(value)
                    ? undefined
                    : "Not a recognized GitHub pull request URL",
        });
        if (!rawUrl) {
            return;
        }
    }

    const coords = parsePullRequestUrl(rawUrl);
    if (!coords) {
        await vscode.window.showErrorMessage(
            "That doesn't look like a GitHub pull request URL."
        );
        return;
    }

    await runFlow(context, coords);
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
                description: `$(repo) ${entry.coords.owner}/${entry.coords.repo} $(git-pull-request) #${entry.coords.number} · ${formatBytesShort(
                    entry.artifact.sizeInBytes
                )} · ${formatRelativeTime(new Date(entry.downloadedAt).toISOString())}`,
                detail: `${runIcon} ${workflowName} #${entry.run.runNumber} · $(git-branch) ${branchLabel}@${shortSha}`,
                buttons: [OPEN_PR_BTN, OPEN_RUN_BTN, FORGET_BTN],
                entry,
            });
        }
        items.push({
            label: "More",
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: "$(cloud-download)  Download from a new GitHub Pull Request…",
            description: "Paste a PR URL",
            choice: { kind: "new" },
        });
    } else {
        items.push({
            label: "Get started",
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: "$(cloud-download)  Download from a GitHub Pull Request",
            description: "Paste a PR URL to fetch its workflow artifacts",
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
                ? `Pick a recent artifact, or paste a PR URL to download a new one… (${recent.length} cached)`
                : "Paste a GitHub pull request URL to download an artifact…";
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
            if (e.button === OPEN_PR_BTN) {
                const url = `https://github.com/${entry.coords.owner}/${entry.coords.repo}/pull/${entry.coords.number}`;
                void vscode.env.openExternal(vscode.Uri.parse(url));
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
                // If user typed a URL into the filter while "Download from new
                // PR…" was the only matching item, prefill it so they don't
                // have to paste it twice.
                if (
                    picked.choice.kind === "new" &&
                    typed &&
                    parsePullRequestUrl(typed)
                ) {
                    finish({ kind: "new", prefilledUrl: typed });
                } else {
                    finish(picked.choice);
                }
                return;
            }
            // No item matched the filter (common when the user pastes a PR
            // URL directly into the search box). If the typed value parses
            // as a PR URL, treat it as the intent.
            if (typed && parsePullRequestUrl(typed)) {
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
        coords: entry.coords,
        run: entry.run,
        artifact: entry.artifact,
        extracted: entry.extracted,
    };
    await dispatchHandler(handlerCtx);
}

async function runFlow(
    context: vscode.ExtensionContext,
    coords: PullRequestCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;

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
            prUrl: `https://github.com/${coords.owner}/${coords.repo}/pull/${coords.number}`,
            retry: () => runFlow(context, coords),
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
            prUrl: head.htmlUrl,
            retry: () => runFlow(context, coords),
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

    const chosenArtifact = await pickArtifact(artifacts, run);
    if (!chosenArtifact) {
        return;
    }

    const configuredMaxBytes = getConfiguredMaxArtifactBytes();
    let effectiveMaxBytes = configuredMaxBytes;
    if (chosenArtifact.sizeInBytes > configuredMaxBytes) {
        const confirmed = await confirmOversizeDownload(
            chosenArtifact.sizeInBytes,
            configuredMaxBytes
        );
        if (!confirmed) {
            return;
        }
        effectiveMaxBytes = Math.min(
            Math.max(chosenArtifact.sizeInBytes * 2, configuredMaxBytes),
            HARD_LIMIT_BYTES
        );
    }

    let zipBytes: Uint8Array;
    try {
        zipBytes = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Asciinema — Downloading artifact "${chosenArtifact.name}"`,
                cancellable: false,
            },
            (progress) => {
                let lastPct = 0;
                let lastReport = 0;
                const startedAt = Date.now();
                return downloadArtifactZip(
                    token,
                    coords,
                    chosenArtifact.id,
                    effectiveMaxBytes,
                    (p) => {
                        const now = Date.now();
                        // Throttle updates to ~10/sec to avoid UI spam.
                        if (now - lastReport < 100 && p.received < (p.total ?? 0)) {
                            return;
                        }
                        lastReport = now;
                        const totalStr = p.total
                            ? formatBytesShort(p.total)
                            : "?";
                        const recvStr = formatBytesShort(p.received);
                        let message: string;
                        let increment = 0;
                        if (p.total && p.total > 0) {
                            const pct = Math.min(
                                100,
                                Math.floor((p.received / p.total) * 100)
                            );
                            increment = pct - lastPct;
                            lastPct = pct;
                            message = `${recvStr} of ${totalStr} (${pct}%)`;
                        } else {
                            message = `${recvStr} downloaded`;
                        }
                        const quip = getDownloadQuip(now - startedAt);
                        if (quip) {
                            message = `${message} — ${quip}`;
                        }
                        progress.report({ message, increment });
                    }
                );
            }
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to download the artifact zip.",
            prUrl: head.htmlUrl,
            retry: () => runFlow(context, coords),
        });
        return;
    }

    const limits = getDiskExtractionLimits();
    let extracted: Awaited<ReturnType<typeof extractArtifactToDisk>> | undefined;
    let currentLimits = limits;
    let attempt = 0;
    while (!extracted) {
        try {
            extracted = await runExtractWithProgress(
                context,
                chosenArtifact,
                zipBytes,
                currentLimits,
                attempt > 0 // resume from prior partial extraction
            );
        } catch (err) {
            if (err instanceof ZipLimitError) {
                const next = await handleZipLimitError(err, currentLimits);
                if (next === undefined) {
                    return;
                }
                currentLimits = next;
                attempt++;
                continue;
            }
            await vscode.window.showErrorMessage(
                `Couldn't extract artifact zip: ${(err as Error).message}`
            );
            return;
        }
    }

    const handlerCtx: HandlerContext = {
        extensionContext: context,
        coords,
        run,
        artifact: chosenArtifact,
        extracted,
    };
    recordRecent({
        coords,
        run,
        artifact: chosenArtifact,
        extracted,
    }).catch(() => {
        // best-effort persistence
    });
    await dispatchHandler(handlerCtx);
}

async function confirmOversizeDownload(
    actualBytes: number,
    configuredBytes: number
): Promise<boolean> {
    const actualMB = formatMB(actualBytes);
    const configuredMB = formatMB(configuredBytes);
    const overBy = formatMB(actualBytes - configuredBytes);
    const proceed = "Download Anyway";
    const choice = await vscode.window.showWarningMessage(
        `This artifact is ${actualMB} MB, which is ${overBy} MB over your configured limit of ${configuredMB} MB (\`asciinema.maxArtifactSizeMB\`). Download it anyway?`,
        { modal: true },
        proceed
    );
    return choice === proceed;
}

function formatMB(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
}

async function runExtractWithProgress(
    context: vscode.ExtensionContext,
    chosenArtifact: WorkflowArtifact,
    zipBytes: Uint8Array,
    limits: DiskExtractionLimits,
    resume = false
): Promise<Awaited<ReturnType<typeof extractArtifactToDisk>>> {
    return await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: resume
                ? `Asciinema — Resuming extraction "${chosenArtifact.name}"`
                : `Asciinema — Extracting artifact "${chosenArtifact.name}"`,
            cancellable: false,
        },
        (progress) => {
            let lastPct = 0;
            let lastReport = 0;
            const startedAt = Date.now();
            return extractArtifactToDisk(
                context,
                chosenArtifact.id,
                zipBytes,
                limits,
                (p) => {
                    const now = Date.now();
                    if (
                        now - lastReport < 100 &&
                        p.filesWritten < p.totalFiles
                    ) {
                        return;
                    }
                    lastReport = now;
                    const pct =
                        p.totalFiles > 0
                            ? Math.min(
                                  100,
                                  Math.floor(
                                      (p.filesWritten / p.totalFiles) * 100
                                  )
                              )
                            : 0;
                    const increment = pct - lastPct;
                    lastPct = pct;
                    const sizeStr = formatBytesShort(p.bytesWritten);
                    let message = `${p.filesWritten.toLocaleString()} / ${p.totalFiles.toLocaleString()} files · ${sizeStr} (${pct}%)`;
                    const quip = getExtractionQuip(now - startedAt);
                    if (quip) {
                        message = `${message} — ${quip}`;
                    }
                    progress.report({ message, increment });
                },
                resume
            );
        }
    );
}

interface ZipLimitMeta {
    /** Human-friendly singular noun, e.g. "files", "MB". */
    readonly unit: string;
    /** VS Code setting key (without the `asciinema.` prefix). */
    readonly settingKey: string;
    /** Friendly setting label shown in the prompt. */
    readonly settingLabel: string;
    /** Convert a raw cap (bytes/count) to user-facing units. */
    readonly toUnits: (raw: number) => number;
    /** Convert user-facing units back to raw (bytes/count). */
    readonly fromUnits: (units: number) => number;
    /** Apply a new value into the limits object. */
    readonly applyToLimits: (
        current: DiskExtractionLimits,
        rawValue: number
    ) => DiskExtractionLimits;
}

const ZIP_LIMIT_META: Record<string, ZipLimitMeta | undefined> = {
    entries: {
        unit: "files",
        settingKey: "maxArtifactEntryCount",
        settingLabel: "Max artifact entry count",
        toUnits: (n) => n,
        fromUnits: (n) => Math.floor(n),
        applyToLimits: (cur, val) => ({ ...cur, maxEntries: val }),
    },
    entrySize: {
        unit: "MB",
        settingKey: "maxArtifactEntrySizeMB",
        settingLabel: "Max single-file size (MB)",
        toUnits: (b) => Math.ceil(b / 1024 / 1024),
        fromUnits: (mb) => Math.round(mb * 1024 * 1024),
        applyToLimits: (cur, val) => ({ ...cur, maxEntryBytes: val }),
    },
    totalSize: {
        unit: "MB",
        settingKey: "maxArtifactExtractedMB",
        settingLabel: "Max total extracted size (MB)",
        toUnits: (b) => Math.ceil(b / 1024 / 1024),
        fromUnits: (mb) => Math.round(mb * 1024 * 1024),
        applyToLimits: (cur, val) => ({ ...cur, maxTotalBytes: val }),
    },
};

/**
 * Friendly recovery UX when an extraction trips a configurable cap.
 * Returns the new `DiskExtractionLimits` to retry with, or `undefined` if
 * the user chose to abort.
 */
async function handleZipLimitError(
    err: ZipLimitError,
    current: DiskExtractionLimits
): Promise<DiskExtractionLimits | undefined> {
    const meta = ZIP_LIMIT_META[err.kind];
    if (!meta) {
        // Non-recoverable kinds (symlink, traversal) — just report.
        await vscode.window.showErrorMessage(err.message);
        return undefined;
    }

    // Suggest at least 2× current cap, or just over the observed value
    // (with 25% headroom), whichever is larger.
    const capRaw = err.cap ?? 0;
    const observedRaw = err.observed ?? capRaw;
    const suggestedRaw = Math.max(
        capRaw * 2,
        Math.ceil(observedRaw * 1.25),
        capRaw + 1
    );
    const currentDisp = meta.toUnits(capRaw);
    const suggestedDisp = meta.toUnits(suggestedRaw);
    const observedDisp = meta.toUnits(observedRaw);

    const increaseAndRetry = `Raise to ${suggestedDisp.toLocaleString()} ${meta.unit} & Retry`;
    const customRetry = `Set custom value…`;
    const openSettings = "Open Settings";
    const cancel = "Cancel";

    const choice = await vscode.window.showErrorMessage(
        `${err.message}\n\nObserved ${observedDisp.toLocaleString()} ${meta.unit}; current cap ${currentDisp.toLocaleString()} ${meta.unit} (\`asciinema.${meta.settingKey}\`).`,
        { modal: false },
        increaseAndRetry,
        customRetry,
        openSettings,
        cancel
    );

    if (!choice || choice === cancel) {
        return undefined;
    }

    if (choice === openSettings) {
        await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `@id:asciinema.${meta.settingKey}`
        );
        return undefined;
    }

    let newRaw = suggestedRaw;
    if (choice === customRetry) {
        const input = await vscode.window.showInputBox({
            title: `Asciinema — ${meta.settingLabel}`,
            prompt: `Enter a new cap in ${meta.unit}. Current: ${currentDisp.toLocaleString()}. Observed: ${observedDisp.toLocaleString()}.`,
            value: String(suggestedDisp),
            validateInput: (v) => {
                const n = Number(v);
                if (!Number.isFinite(n) || n <= 0) {
                    return "Enter a positive number.";
                }
                if (meta.fromUnits(n) <= observedRaw) {
                    return `Must be greater than ${observedDisp.toLocaleString()} ${meta.unit} to fit this artifact.`;
                }
                return undefined;
            },
        });
        if (!input) {
            return undefined;
        }
        newRaw = meta.fromUnits(Number(input));
    }

    // Persist the new cap in user (global) settings so it sticks for next time.
    try {
        const cfg = vscode.workspace.getConfiguration("asciinema");
        await cfg.update(
            meta.settingKey,
            meta.toUnits(newRaw),
            vscode.ConfigurationTarget.Global
        );
    } catch {
        // best-effort — even if persisting fails we still retry with new limits
    }

    return meta.applyToLimits(current, newRaw);
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

interface ArtifactQuickPickItem extends vscode.QuickPickItem {
    readonly artifact?: WorkflowArtifact;
}

async function pickArtifact(
    artifacts: readonly WorkflowArtifact[],
    run: WorkflowRunSummary
): Promise<WorkflowArtifact | undefined> {
    if (artifacts.length === 1) {
        return artifacts[0];
    }
    const sorted = [...artifacts].sort(
        (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const runIcon = conclusionIcon(run.conclusion);
    const workflowName = run.name ?? "workflow";
    const branchLabel = run.headBranch ?? "(detached)";
    const shortSha = run.headSha.slice(0, 7);
    const actorLabel = run.actor ?? "unknown";

    const openRunBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("link-external"),
        tooltip: "Open workflow run on github.com",
    };

    const items: ArtifactQuickPickItem[] = [
        {
            label: `${workflowName} #${run.runNumber}`,
            kind: vscode.QuickPickItemKind.Separator,
        },
    ];
    for (const a of sorted) {
        items.push({
            label: `$(package)  ${a.name}`,
            description: `${formatBytesShort(a.sizeInBytes)} · ${formatRelativeTime(
                a.createdAt
            )} · ${runIcon} ${workflowName} #${run.runNumber}`,
            detail: `${branchLabel}@${shortSha} · triggered by ${actorLabel}`,
            buttons: [openRunBtn],
            artifact: a,
        });
    }

    const picked = await showQuickPick(items, {
        title: "Asciinema — select an artifact",
        placeholder: "Type to filter — name, size, branch, sha, actor…",
        onTriggerItemButton: () => {
            void vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl));
        },
    });
    return picked?.artifact;
}

interface ApiErrorContext {
    readonly notFoundMessage: string;
    readonly prUrl: string;
    readonly retry: () => Promise<void> | void;
}

async function handleApiError(
    err: unknown,
    ctx: ApiErrorContext
): Promise<void> {
    if (err instanceof GitHubApiError) {
        if (err.status === 401 || err.status === 403 || err.status === 404) {
            const choice = await vscode.window.showErrorMessage(
                `${ctx.notFoundMessage} ${err.message}`,
                "Open PR in Browser"
            );
            if (choice === "Open PR in Browser") {
                await vscode.env.openExternal(vscode.Uri.parse(ctx.prUrl));
            }
            return;
        }
        if (err.retryable) {
            const choice = await vscode.window.showErrorMessage(
                err.message,
                "Retry"
            );
            if (choice === "Retry") {
                await ctx.retry();
            }
            return;
        }
        await vscode.window.showErrorMessage(err.message);
        return;
    }
    await vscode.window.showErrorMessage(
        `Unexpected error: ${(err as Error).message}`
    );
}
