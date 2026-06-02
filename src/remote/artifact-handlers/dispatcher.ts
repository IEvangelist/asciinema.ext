import * as vscode from "vscode";
import type {
    ArtifactHandler,
    HandlerCandidate,
    HandlerContext,
} from "./handler-types.js";
import { castHandler } from "./cast-handler.js";
import { staticSiteHandler } from "./static-site-handler.js";
import { showQuickPick } from "./quickpick.js";
import {
    deleteArtifactZip,
    extractArtifactToDisk,
    getArtifactExtractedDir,
} from "../temp-storage.js";
import { isAbortError, type DiskExtractionLimits } from "../zip-extract.js";
import { ZipLimitError } from "../artifact-zip.js";
import { buildProgressMessage } from "../progress-format.js";
import { getExtractionQuip } from "../download-quips.js";
import {
    pickPaletteAction,
    showPaletteNotice,
    withPaletteProgress,
} from "../quick-input.js";
import * as fs from "node:fs/promises";

const HANDLERS: readonly ArtifactHandler[] = [castHandler, staticSiteHandler];

const DEFAULT_MAX_EXTRACTED_MB = 2048;
const DEFAULT_MAX_ENTRY_COUNT = 250_000;
const DEFAULT_MAX_ENTRY_SIZE_MB = 500;
const LIMIT_HEADROOM_MULTIPLIER = 1.2;

interface DispatchItem extends vscode.QuickPickItem {
    readonly handler?: ArtifactHandler;
    readonly candidate?: HandlerCandidate;
    readonly fallback?: "reveal";
}

/**
 * Detects every applicable handler for `ctx`, prompts the user to pick one
 * (skipping the prompt when there's exactly one specialized match), and
 * runs it.
 *
 * The detection step runs against `ctx.bundle.files` (a posix entry
 * listing, no disk extraction required). When the chosen handler needs the
 * files unpacked (cast / Browse fallback), the dispatcher extracts on
 * demand here, then deletes the cached `.zip` so we don't double-pay
 * cache. Static-site handler reads straight from the zip and never
 * triggers an extraction.
 */
export async function dispatchHandler(ctx: HandlerContext): Promise<void> {
    const matches: Array<{
        handler: ArtifactHandler;
        candidate: HandlerCandidate;
    }> = [];
    for (const handler of HANDLERS) {
        const candidate = await handler.detect(ctx);
        if (candidate) {
            matches.push({ handler, candidate });
        }
    }
    matches.sort((a, b) => a.candidate.priority - b.candidate.priority);

    if (matches.length === 0) {
        await ensureExtracted(ctx);
        if (!ctx.extracted) {
            return;
        }
        await revealExtractedInExplorer(ctx);
        return;
    }

    if (matches.length === 1) {
        const m = matches[0];
        if (handlerNeedsExtracted(m.handler)) {
            await ensureExtracted(ctx);
            if (!ctx.extracted) {
                return;
            }
        }
        await m.handler.open(ctx, m.candidate);
        return;
    }

    const items: DispatchItem[] = [
        {
            label: "Detected handlers",
            kind: vscode.QuickPickItemKind.Separator,
        },
    ];
    for (const m of matches) {
        items.push({
            label: `${m.candidate.icon}  ${m.candidate.label}`,
            description: m.candidate.description,
            detail: m.candidate.detail,
            handler: m.handler,
            candidate: m.candidate,
        });
    }
    items.push(
        {
            label: "Other",
            kind: vscode.QuickPickItemKind.Separator,
        },
        {
            label: "$(folder-opened)  Browse extracted files…",
            description:
                "Open in a new window, add to workspace, or show in the OS file manager",
            detail:
                ctx.extracted?.rootDir.fsPath ??
                getArtifactExtractedDir(
                    ctx.extensionContext,
                    ctx.artifact.id
                ).fsPath,
            fallback: "reveal",
        }
    );

    const picked = await showQuickPick(items, {
        title: `Open artifact "${ctx.artifact.name}" as…`,
        placeholder: "Type to filter handlers…",
    });
    if (!picked) {
        return;
    }
    if (picked.fallback === "reveal") {
        await ensureExtracted(ctx);
        if (!ctx.extracted) {
            return;
        }
        await revealExtractedInExplorer(ctx);
        return;
    }
    if (picked.handler && picked.candidate) {
        if (handlerNeedsExtracted(picked.handler)) {
            await ensureExtracted(ctx);
            if (!ctx.extracted) {
                return;
            }
        }
        await picked.handler.open(ctx, picked.candidate);
    }
}

function handlerNeedsExtracted(handler: ArtifactHandler): boolean {
    // The static-site handler can serve directly from the cached zip; every
    // other current handler needs the inflated tree on disk.
    return handler !== staticSiteHandler;
}

/**
 * Inflates `ctx.bundle.zipPath` into the artifact's extraction directory
 * and assigns the result to `ctx.extracted`. No-op when `ctx.extracted` is
 * already set (re-opened v2 recent or earlier dispatcher decision). After
 * a successful extract the cached `.zip` is removed — at that point the
 * extracted tree is the source of truth.
 *
 * Surfaces full Raise-&-Retry recovery for `ZipLimitError`. Silently
 * unwinds on cancellation (`AbortError`).
 */
async function ensureExtracted(ctx: HandlerContext): Promise<void> {
    if (ctx.extracted) {
        return;
    }
    const zipPath = ctx.bundle.zipPath.fsPath;
    let zipBytes: Uint8Array;
    try {
        const buf = await fs.readFile(zipPath);
        zipBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
        await showPaletteNotice(
            "GitHub Artifacts — cached zip failed",
            `Couldn't read cached artifact zip: ${(err as Error).message}`,
            "error"
        );
        return;
    }

    let currentLimits = getDiskExtractionLimits();
    let attempt = 0;
    for (;;) {
        try {
            const extracted = await runExtractWithProgress(
                ctx,
                zipBytes,
                currentLimits,
                attempt > 0
            );
            if (!extracted) {
                return;
            }
            ctx.extracted = extracted;
            // Now that the extracted tree is the source of truth, drop the
            // cached `.zip` so we don't pay double disk for this artifact.
            await deleteArtifactZip(ctx.extensionContext, ctx.artifact.id);
            return;
        } catch (err) {
            if (isAbortError(err)) {
                // User cancelled — leave any partial state behind for a
                // future `resume: true` retry. No popup needed.
                return;
            }
            if (err instanceof ZipLimitError) {
                const next = await handleZipLimitError(err, currentLimits);
                if (next === undefined) {
                    return;
                }
                currentLimits = next;
                attempt++;
                continue;
            }
            await showPaletteNotice(
                "GitHub Artifacts — extraction failed",
                `Couldn't extract artifact zip: ${(err as Error).message}`,
                "error"
            );
            return;
        }
    }
}

async function runExtractWithProgress(
    ctx: HandlerContext,
    zipBytes: Uint8Array,
    limits: DiskExtractionLimits,
    resume: boolean
): Promise<Awaited<ReturnType<typeof extractArtifactToDisk>> | undefined> {
    return await withPaletteProgress(
        {
            title: resume
                ? `GitHub Artifacts — Resuming extraction "${ctx.artifact.name}"`
                : `GitHub Artifacts — Extracting artifact "${ctx.artifact.name}"`,
            placeholder: resume
                ? "Resuming artifact extraction..."
                : "Extracting artifact files...",
            cancellable: true,
            initialMessage: resume
                ? "Checking existing extracted files"
                : "Preparing extraction",
        },
        async (progress, token) => {
            const controller = new AbortController();
            const sub = token.onCancellationRequested(() => {
                controller.abort();
            });
            let lastPct = 0;
            let lastReport = 0;
            const startedAt = Date.now();
            try {
                return await extractArtifactToDisk(
                    ctx.extensionContext,
                    ctx.artifact.id,
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
                    resume,
                    controller.signal
                );
            } finally {
                sub.dispose();
            }
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
        await showPaletteNotice(
            "GitHub Artifacts — extraction limit",
            err.message,
            "error"
        );
        return undefined;
    }

    const capRaw = err.cap ?? 0;
    const observedRaw = err.observed ?? capRaw;
    const suggestedRaw = Math.max(
        Math.ceil(observedRaw * LIMIT_HEADROOM_MULTIPLIER),
        observedRaw + 1,
        capRaw + 1
    );
    const currentDisp = meta.toUnits(capRaw);
    const suggestedDisp = meta.toUnits(suggestedRaw);
    const observedDisp = meta.toUnits(observedRaw);

    const choice = await pickPaletteAction(
        [
            {
                label: `$(arrow-up)  Raise to ${suggestedDisp.toLocaleString()} ${meta.unit} and retry`,
                description: "Recommended: 20% above this artifact",
                detail: `Observed ${observedDisp.toLocaleString()} ${meta.unit}; setting: asciinema.${meta.settingKey}`,
                value: "raise",
            },
            {
                label: "$(edit)  Set custom value...",
                description: `Enter a new ${meta.unit} cap`,
                value: "custom",
            },
            {
                label: "$(settings-gear)  Open Settings",
                description: `asciinema.${meta.settingKey}`,
                value: "settings",
            },
            {
                label: "$(close)  Cancel",
                value: "cancel",
            },
        ],
        {
            title: `GitHub Artifacts — ${meta.settingLabel}`,
            message: err.message,
            placeholder: `Observed ${observedDisp.toLocaleString()} ${meta.unit}; current cap ${currentDisp.toLocaleString()} ${meta.unit}`,
        }
    );

    if (!choice || choice === "cancel") {
        return undefined;
    }

    if (choice === "settings") {
        await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `@id:asciinema.${meta.settingKey}`
        );
        return undefined;
    }

    let newRaw = suggestedRaw;
    if (choice === "custom") {
        const input = await vscode.window.showInputBox({
            title: `GitHub Artifacts — ${meta.settingLabel}`,
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

async function revealExtractedInExplorer(ctx: HandlerContext): Promise<void> {
    const dir = ctx.extracted?.rootDir;
    if (!dir) {
        return;
    }
    const inNewWindow = "$(empty-window)  Open folder in new VS Code window";
    const addToWorkspace = "$(multiple-windows)  Add folder to current workspace";
    const showInOs = `$(file-directory)  Show in ${osFileManagerName()}`;
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: inNewWindow,
                description: "Treat the artifact as a workspace",
                detail: dir.fsPath,
                value: "new" as const,
            },
            {
                label: addToWorkspace,
                description: "Mount it as an additional folder in this window",
                detail: dir.fsPath,
                value: "add" as const,
            },
            {
                label: showInOs,
                description: "Open in the system file manager",
                detail: dir.fsPath,
                value: "os" as const,
            },
        ],
        {
            title: `Browse extracted artifact "${ctx.artifact.name}"`,
            placeHolder: "How would you like to browse the files?",
            ignoreFocusOut: true,
        }
    );
    if (!choice) {
        return;
    }

    try {
        switch (choice.value) {
            case "new":
                await vscode.commands.executeCommand("vscode.openFolder", dir, {
                    forceNewWindow: true,
                });
                return;
            case "add": {
                const existing = vscode.workspace.workspaceFolders ?? [];
                const inserted = vscode.workspace.updateWorkspaceFolders(
                    existing.length,
                    null,
                    {
                        uri: dir,
                        name: `artifact: ${ctx.artifact.name}`,
                    }
                );
                if (!inserted) {
                    // updateWorkspaceFolders returns false if the folder is
                    // already there or VS Code refused — fall back to opening
                    // it in a new window so the user still ends up somewhere.
                    await vscode.commands.executeCommand(
                        "vscode.openFolder",
                        dir,
                        { forceNewWindow: true }
                    );
                }
                return;
            }
            case "os":
                await vscode.env.openExternal(dir);
                return;
        }
    } catch (err) {
        await showPaletteNotice(
            "GitHub Artifacts — open folder failed",
            `Couldn't open ${dir.fsPath}: ${(err as Error).message}`,
            "error"
        );
    }
}

function osFileManagerName(): string {
    switch (process.platform) {
        case "win32":
            return "File Explorer";
        case "darwin":
            return "Finder";
        default:
            return "file manager";
    }
}
