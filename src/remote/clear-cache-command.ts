import * as vscode from "vscode";
import {
    cacheFolderLabel,
    clearArtifactsRoot,
    clearCastsRoot,
    computeCacheStats,
    formatBytes,
    formatDateRange,
} from "./cache-actions.js";
import {
    forgetAllRecents,
    listRecent,
    recentsDateRange,
    removeRecentsSince,
} from "./recent-artifacts.js";

interface ClearCacheItem extends vscode.QuickPickItem {
    readonly action:
        | "clear-all"
        | "clear-recent-7d"
        | "clear-casts"
        | "clear-artifacts"
        | "open-folder";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Implementation of the `asciinema.clearCache` command.
 *
 * Opens a QuickPick of cleanup actions; each row shows live size, item
 * count, and (where meaningful) the date range, so the user knows exactly
 * what they're about to drop *before* they hit Enter.
 */
export async function clearCacheCommand(
    context: vscode.ExtensionContext
): Promise<void> {
    const stats = await computeCacheStats(context);
    const recents = await listRecent();
    const range = recentsDateRange();

    const recentBytesLast7d = recents
        .filter((r) => r.downloadedAt >= Date.now() - SEVEN_DAYS_MS)
        .reduce((sum, r) => {
            const sz =
                r.kind === "zip"
                    ? r.bundle.zipSizeBytes
                    : r.extracted.totalBytes;
            return sum + sz;
        }, 0);
    const recentCountLast7d = recents.filter(
        (r) => r.downloadedAt >= Date.now() - SEVEN_DAYS_MS
    ).length;

    const totalLabel = formatBytes(stats.totalBytes);
    const itemLabel = `${stats.artifactCount} ${
        stats.artifactCount === 1 ? "item" : "items"
    }`;
    const rangeLabel = range
        ? ` · ${formatDateRange(range.min, range.max)}`
        : "";

    const items: ClearCacheItem[] = [
        {
            label: "$(clear-all)  Clear all",
            description: `${totalLabel} · ${itemLabel}${rangeLabel}`,
            detail: "Wipes every cached artifact and session cast file",
            action: "clear-all",
        },
        {
            label: "$(history)  Clear recent (last 7 days)",
            description:
                recentCountLast7d > 0
                    ? `${formatBytes(recentBytesLast7d)} · ${recentCountLast7d} ${
                          recentCountLast7d === 1 ? "recent" : "recents"
                      }`
                    : "Nothing in the last 7 days",
            detail: "Forgets recents downloaded in the last week and removes their cached files",
            action: "clear-recent-7d",
        },
        {
            label: "$(record)  Clear casts only",
            description: `${formatBytes(stats.castsBytes)} · remote-casts/`,
            detail: "Per-session temp .cast files",
            action: "clear-casts",
        },
        {
            label: "$(package)  Clear artifacts only",
            description: `${formatBytes(stats.artifactsBytes)} · remote-artifacts/ · ${itemLabel}`,
            detail: "Cached zips + extracted trees + their recents",
            action: "clear-artifacts",
        },
        {
            label: "$(folder-opened)  Open cache folder",
            description: cacheFolderLabel(context),
            detail: "Open in your OS file manager — no changes made",
            action: "open-folder",
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: `GitHub Artifacts — Clear extension cache (${totalLabel})`,
        placeHolder: "Pick what to clear…",
        ignoreFocusOut: true,
    });
    if (!picked) {
        return;
    }

    switch (picked.action) {
        case "open-folder":
            await vscode.env.openExternal(context.globalStorageUri);
            return;
        case "clear-all": {
            if (
                !(await confirm(
                    `Clear ${totalLabel} of cached data? Cached artifacts and session cast files will be deleted.`,
                    "Clear all"
                ))
            ) {
                return;
            }
            const a = await clearArtifactsRoot(context);
            const c = await clearCastsRoot(context);
            await forgetAllRecents();
            await vscode.window.showInformationMessage(
                `Cleared ${formatBytes(a + c)} of Asciinema cache.`
            );
            return;
        }
        case "clear-recent-7d": {
            if (recentCountLast7d === 0) {
                await vscode.window.showInformationMessage(
                    "No recent artifacts in the last 7 days."
                );
                return;
            }
            if (
                !(await confirm(
                    `Forget the ${recentCountLast7d} ${
                        recentCountLast7d === 1 ? "recent" : "recents"
                    } from the last 7 days (${formatBytes(
                        recentBytesLast7d
                    )})? Their cached files will be deleted.`,
                    "Forget recents"
                ))
            ) {
                return;
            }
            const since = Date.now() - SEVEN_DAYS_MS;
            const result = await removeRecentsSince(since);
            await vscode.window.showInformationMessage(
                `Cleared ${formatBytes(result.bytes)} across ${
                    result.count
                } recent ${result.count === 1 ? "artifact" : "artifacts"}.`
            );
            return;
        }
        case "clear-casts": {
            if (stats.castsBytes === 0) {
                await vscode.window.showInformationMessage(
                    "No cached cast files to clear."
                );
                return;
            }
            if (
                !(await confirm(
                    `Clear ${formatBytes(
                        stats.castsBytes
                    )} of cached cast files?`,
                    "Clear casts"
                ))
            ) {
                return;
            }
            const c = await clearCastsRoot(context);
            await vscode.window.showInformationMessage(
                `Cleared ${formatBytes(c)} of session cast files.`
            );
            return;
        }
        case "clear-artifacts": {
            if (stats.artifactsBytes === 0 && stats.artifactCount === 0) {
                await vscode.window.showInformationMessage(
                    "No cached artifacts to clear."
                );
                return;
            }
            if (
                !(await confirm(
                    `Clear ${formatBytes(stats.artifactsBytes)} across ${
                        stats.artifactCount
                    } cached ${
                        stats.artifactCount === 1 ? "artifact" : "artifacts"
                    }? Recents will be forgotten too.`,
                    "Clear artifacts"
                ))
            ) {
                return;
            }
            const a = await clearArtifactsRoot(context);
            await forgetAllRecents();
            await vscode.window.showInformationMessage(
                `Cleared ${formatBytes(a)} across ${
                    stats.artifactCount
                } cached ${
                    stats.artifactCount === 1 ? "artifact" : "artifacts"
                }.`
            );
            return;
        }
    }
}

async function confirm(message: string, action: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        action
    );
    return choice === action;
}
