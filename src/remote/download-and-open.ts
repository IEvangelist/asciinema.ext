import * as vscode from "vscode";
import {
    GitHubApiError,
    downloadArtifactZip,
    type WorkflowArtifact,
    type WorkflowRunSummary,
} from "./github-client.js";
import { ZipLimitError } from "./artifact-zip.js";
import { saveArtifactZip } from "./temp-storage.js";
import { isAbortError } from "./zip-extract.js";
import { dispatchHandler } from "./artifact-handlers/dispatcher.js";
import type { HandlerContext } from "./artifact-handlers/handler-types.js";
import {
    conclusionIcon,
    formatBytesShort,
    formatRelativeTime,
} from "./quickpick-helpers.js";
import { showQuickPick } from "./artifact-handlers/quickpick.js";
import { getDownloadQuip } from "./download-quips.js";
import { buildProgressMessage } from "./progress-format.js";
import { recordRecent } from "./recent-artifacts.js";
import {
    repoOf,
    type ArtifactSource,
} from "./artifact-source.js";
import {
    pickPaletteAction,
    showPaletteNotice,
    withPaletteProgress,
} from "./quick-input.js";

const DEFAULT_MAX_ARTIFACT_MB = 250;
const DEFAULT_MAX_ENTRY_COUNT = 250_000;
const HARD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

function getConfiguredMaxArtifactBytes(): number {
    const mb = vscode.workspace
        .getConfiguration("asciinema")
        .get<number>("maxArtifactSizeMB", DEFAULT_MAX_ARTIFACT_MB);
    const safe = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_ARTIFACT_MB;
    return Math.round(safe * 1024 * 1024);
}

function getMaxEntries(): number {
    const n = vscode.workspace
        .getConfiguration("asciinema")
        .get<number>("maxArtifactEntryCount", DEFAULT_MAX_ENTRY_COUNT);
    const safe =
        Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ENTRY_COUNT;
    return safe;
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
 * pair: prompt for which artifact to open, download with progress, peek
 * the zip's central directory, record in recents, and dispatch to a
 * handler. Extraction to disk (when needed) is performed lazily by the
 * dispatcher *after* the user picks a non-HTML handler.
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
        await showPaletteNotice(
            "GitHub Artifacts — sign in unavailable",
            "GitHub sign-in is no longer available.",
            "error"
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

    let zipBytes: Uint8Array | undefined;
    try {
        zipBytes = await withPaletteProgress(
            {
                title: `GitHub Artifacts — Downloading "${chosenArtifact.name}"`,
                placeholder: "Downloading artifact...",
                cancellable: true,
                initialMessage: "Starting download",
            },
            async (progress, token2) => {
                const controller = new AbortController();
                const sub = token2.onCancellationRequested(() => {
                    controller.abort();
                });
                let lastPct = 0;
                let lastReport = 0;
                const startedAt = Date.now();
                try {
                    return await downloadArtifactZip(
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
                        },
                        controller.signal
                    );
                } finally {
                    sub.dispose();
                }
            }
        );
    } catch (err) {
        if (isAbortError(err)) {
            // User cancelled — keep silent.
            return;
        }
        await reportApiError(err, options);
        return;
    }
    if (!zipBytes) {
        return;
    }

    let bundle: Awaited<ReturnType<typeof saveArtifactZip>>;
    try {
        bundle = await withPaletteProgress(
            {
                title: `GitHub Artifacts — Inspecting "${chosenArtifact.name}"`,
                placeholder: "Reading artifact zip contents...",
                initialMessage: "Inspecting zip entries",
            },
            () =>
                saveArtifactZip(context, chosenArtifact.id, zipBytes!, {
                    maxEntries: getMaxEntries(),
                })
        );
    } catch (err) {
        if (err instanceof ZipLimitError) {
            await showPaletteNotice(
                "GitHub Artifacts — artifact zip limit",
                err.message,
                "error"
            );
            return;
        }
        await showPaletteNotice(
            "GitHub Artifacts — artifact zip failed",
            `Couldn't open artifact zip: ${(err as Error).message}`,
            "error"
        );
        return;
    }

    const handlerCtx: HandlerContext = {
        extensionContext: context,
        coords: repo,
        run,
        artifact: chosenArtifact,
        bundle,
    };
    void recordRecent({
        source,
        run,
        artifact: chosenArtifact,
        bundle,
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
    const choice = await pickPaletteAction(
        [
            {
                label: "$(cloud-download)  Download anyway",
                description: `${actualMB} MB artifact · ${overBy} MB over limit`,
                detail: `Configured limit: ${configuredMB} MB (asciinema.maxArtifactSizeMB)`,
                value: "download",
            },
            {
                label: "$(close)  Cancel",
                value: "cancel",
            },
        ],
        {
            title: "GitHub Artifacts — artifact exceeds size limit",
            message: `This artifact is ${actualMB} MB, which is ${overBy} MB over your configured limit of ${configuredMB} MB.`,
        }
    );
    return choice === "download";
}

function formatMB(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
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
        title: "GitHub Artifacts — select an artifact",
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
            const choice = await pickPaletteAction(
                [
                    {
                        label: `$(link-external)  ${ctx.fallbackLabel}`,
                        description: "Open github.com for details",
                        value: "open",
                    },
                    {
                        label: "$(close)  Dismiss",
                        value: "dismiss",
                    },
                ],
                {
                    title: "GitHub Artifacts — GitHub API error",
                    message: `${ctx.notFoundMessage} ${err.message}`,
                }
            );
            if (choice === "open") {
                await vscode.env.openExternal(vscode.Uri.parse(ctx.fallbackUrl));
            }
            return;
        }
        if (err.retryable && ctx.retry) {
            const choice = await pickPaletteAction(
                [
                    {
                        label: "$(refresh)  Retry",
                        value: "retry",
                    },
                    {
                        label: "$(close)  Dismiss",
                        value: "dismiss",
                    },
                ],
                {
                    title: "GitHub Artifacts — GitHub API error",
                    message: err.message,
                }
            );
            if (choice === "retry") {
                await ctx.retry();
            }
            return;
        }
        await showPaletteNotice(
            "GitHub Artifacts — GitHub API error",
            err.message,
            "error"
        );
        return;
    }
    await showPaletteNotice(
        "GitHub Artifacts — unexpected error",
        `Unexpected error: ${(err as Error).message}`,
        "error"
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
