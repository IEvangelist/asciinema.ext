import * as vscode from "vscode";
import {
    GitHubApiError,
    downloadArtifactZip,
    type WorkflowArtifact,
    type WorkflowRunSummary,
} from "./github-client.js";
import { ZipLimitError } from "./artifact-zip.js";
import { extractArtifactToDisk } from "./temp-storage.js";
import type { DiskExtractionLimits } from "./zip-extract.js";
import { dispatchHandler } from "./artifact-handlers/dispatcher.js";
import type { HandlerContext } from "./artifact-handlers/handler-types.js";
import {
    conclusionIcon,
    formatBytesShort,
    formatRelativeTime,
} from "./quickpick-helpers.js";
import { showQuickPick } from "./artifact-handlers/quickpick.js";
import { getDownloadQuip, getExtractionQuip } from "./download-quips.js";
import { buildProgressMessage } from "./progress-format.js";
import { recordRecent } from "./recent-artifacts.js";
import {
    repoOf,
    type ArtifactSource,
} from "./artifact-source.js";

const DEFAULT_MAX_ARTIFACT_MB = 250;
const DEFAULT_MAX_EXTRACTED_MB = 2048;
const DEFAULT_MAX_ENTRY_COUNT = 250_000;
const DEFAULT_MAX_ENTRY_SIZE_MB = 500;
const HARD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

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

export interface PickAndOpenOptions {
    /**
     * Generic context used by error UX — what URL to surface as a "view on
     * github.com" fallback, and what label to attach to the button.
     */
    readonly fallbackUrl: string;
    readonly fallbackLabel: string;
}

/**
 * The shared back-half of every command that resolves a (run, artifacts)
 * pair: prompt for which artifact to open, download with progress, extract
 * with progress, record in recents, dispatch to a handler.
 */
export async function pickAndOpenArtifact(
    context: vscode.ExtensionContext,
    source: ArtifactSource,
    run: WorkflowRunSummary,
    artifacts: readonly WorkflowArtifact[],
    options: PickAndOpenOptions
): Promise<void> {
    const repo = repoOf(source);
    const token = (await vscode.authentication.getSession("github", ["repo"], {
        createIfNone: false,
    }))?.accessToken;
    if (!token) {
        // The caller is expected to acquire a session before invoking this
        // helper — but if it's gone by this point (e.g. user revoked it
        // mid-flow), bail with a clear error.
        await vscode.window.showErrorMessage(
            "GitHub sign-in is no longer available."
        );
        return;
    }

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
                    repo,
                    chosenArtifact.id,
                    effectiveMaxBytes,
                    (p) => {
                        const now = Date.now();
                        if (
                            now - lastReport < 100 &&
                            p.received < (p.total ?? 0)
                        ) {
                            return;
                        }
                        lastReport = now;
                        const elapsedMs = now - startedAt;
                        let increment = 0;
                        if (p.total && p.total > 0) {
                            const pct = Math.min(
                                100,
                                Math.floor((p.received / p.total) * 100)
                            );
                            increment = pct - lastPct;
                            lastPct = pct;
                        }
                        const message = buildProgressMessage({
                            received: p.received,
                            total: p.total,
                            elapsedMs,
                            quip: getDownloadQuip(elapsedMs),
                        });
                        progress.report({ message, increment });
                    }
                );
            }
        );
    } catch (err) {
        await reportApiError(err, options);
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
                attempt > 0
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
        coords: repo,
        run,
        artifact: chosenArtifact,
        extracted,
    };
    recordRecent({
        source,
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
                    const elapsedMs = now - startedAt;
                    const message = buildProgressMessage({
                        received: p.bytesWritten,
                        elapsedMs,
                        files: {
                            written: p.filesWritten,
                            total: p.totalFiles,
                        },
                        quip: getExtractionQuip(elapsedMs),
                    });
                    progress.report({ message, increment });
                },
                resume
            );
        }
    );
}

interface ZipLimitMeta {
    readonly unit: string;
    readonly settingKey: string;
    readonly settingLabel: string;
    readonly toUnits: (raw: number) => number;
    readonly fromUnits: (units: number) => number;
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

async function handleZipLimitError(
    err: ZipLimitError,
    current: DiskExtractionLimits
): Promise<DiskExtractionLimits | undefined> {
    const meta = ZIP_LIMIT_META[err.kind];
    if (!meta) {
        await vscode.window.showErrorMessage(err.message);
        return undefined;
    }

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

    try {
        const cfg = vscode.workspace.getConfiguration("asciinema");
        await cfg.update(
            meta.settingKey,
            meta.toUnits(newRaw),
            vscode.ConfigurationTarget.Global
        );
    } catch {
        // best-effort
    }

    return meta.applyToLimits(current, newRaw);
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

export interface ApiErrorContext {
    /**
     * Generic message displayed when the GitHub API returned a 401/403/404.
     * The actual error text from GitHub is appended automatically.
     */
    readonly notFoundMessage: string;
    readonly fallbackLabel: string;
    readonly fallbackUrl: string;
    readonly retry?: () => Promise<void> | void;
}

/**
 * Centralized error UX for failed GitHub API calls. Surfaces a "Retry"
 * button for retryable errors and a source-appropriate "Open … in Browser"
 * fallback for permission / not-found errors.
 */
export async function handleApiError(
    err: unknown,
    ctx: ApiErrorContext
): Promise<void> {
    if (err instanceof GitHubApiError) {
        if (err.status === 401 || err.status === 403 || err.status === 404) {
            const choice = await vscode.window.showErrorMessage(
                `${ctx.notFoundMessage} ${err.message}`,
                ctx.fallbackLabel
            );
            if (choice === ctx.fallbackLabel) {
                await vscode.env.openExternal(vscode.Uri.parse(ctx.fallbackUrl));
            }
            return;
        }
        if (err.retryable && ctx.retry) {
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

/**
 * Smaller helper used by the shared download/extract pipeline when reporting
 * mid-flow errors that have no retry callback in scope.
 */
async function reportApiError(
    err: unknown,
    options: PickAndOpenOptions
): Promise<void> {
    await handleApiError(err, {
        notFoundMessage: "Failed to download the artifact zip.",
        fallbackLabel: options.fallbackLabel,
        fallbackUrl: options.fallbackUrl,
    });
}
