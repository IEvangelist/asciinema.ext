import * as vscode from "vscode";
import * as path from "node:path";

export { formatBytes, formatDateRange } from "./cache-format.js";

/**
 * Recursively totals the size of every file under `uri`. Returns
 * `undefined` when the directory is missing — never throws.
 */
export async function dirSize(uri: vscode.Uri): Promise<number | undefined> {
    let total = 0;
    let touched = false;
    async function walk(current: vscode.Uri): Promise<void> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(current);
        } catch {
            return;
        }
        for (const [name, type] of entries) {
            const child = vscode.Uri.joinPath(current, name);
            if (type === vscode.FileType.Directory) {
                touched = true;
                await walk(child);
            } else if (type === vscode.FileType.File) {
                try {
                    const stat = await vscode.workspace.fs.stat(child);
                    total += stat.size;
                    touched = true;
                } catch {
                    // best-effort
                }
            }
        }
    }
    await walk(uri);
    return touched || total > 0 ? total : undefined;
}

/**
 * Returns the size of a single entry — file or directory. `undefined`
 * when missing.
 */
export async function entrySize(
    uri: vscode.Uri
): Promise<number | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.File) {
            return stat.size;
        }
        if (stat.type === vscode.FileType.Directory) {
            return await dirSize(uri);
        }
    } catch {
        // missing
    }
    return undefined;
}

export interface CacheStats {
    readonly artifactsRoot: vscode.Uri;
    readonly castsRoot: vscode.Uri;
    readonly artifactsBytes: number;
    readonly castsBytes: number;
    readonly artifactCount: number;
    readonly totalBytes: number;
}

const ARTIFACTS_DIR = "remote-artifacts";
const CASTS_DIR = "remote-casts";

/**
 * One-pass summary of the extension's on-disk cache. Walks
 * `globalStorageUri/{remote-artifacts,remote-casts}` to compute totals.
 * Errors during traversal are swallowed; missing subtrees count as zero.
 */
export async function computeCacheStats(
    context: vscode.ExtensionContext
): Promise<CacheStats> {
    const artifactsRoot = vscode.Uri.joinPath(
        context.globalStorageUri,
        ARTIFACTS_DIR
    );
    const castsRoot = vscode.Uri.joinPath(
        context.globalStorageUri,
        CASTS_DIR
    );

    let artifactsBytes = 0;
    let artifactCount = 0;
    try {
        const entries = await vscode.workspace.fs.readDirectory(artifactsRoot);
        for (const [name, type] of entries) {
            const child = vscode.Uri.joinPath(artifactsRoot, name);
            const size = await entrySize(child);
            if (size !== undefined) {
                artifactsBytes += size;
                artifactCount++;
            } else if (type !== undefined) {
                artifactCount++;
            }
        }
    } catch {
        // missing — fine
    }
    const castsBytes = (await dirSize(castsRoot)) ?? 0;

    return {
        artifactsRoot,
        castsRoot,
        artifactsBytes,
        castsBytes,
        artifactCount,
        totalBytes: artifactsBytes + castsBytes,
    };
}

/**
 * Best-effort recursive delete of `remote-artifacts/`. Returns the bytes
 * that were present before the delete (computed via a fresh stat-walk to
 * avoid trusting any stale stats provided by the caller).
 */
export async function clearArtifactsRoot(
    context: vscode.ExtensionContext
): Promise<number> {
    const root = vscode.Uri.joinPath(context.globalStorageUri, ARTIFACTS_DIR);
    const bytes = (await dirSize(root)) ?? 0;
    try {
        await vscode.workspace.fs.delete(root, {
            recursive: true,
            useTrash: false,
        });
    } catch {
        // best-effort
    }
    return bytes;
}

/**
 * Best-effort recursive delete of `remote-casts/`. Returns the bytes
 * that were present before the delete.
 */
export async function clearCastsRoot(
    context: vscode.ExtensionContext
): Promise<number> {
    const root = vscode.Uri.joinPath(context.globalStorageUri, CASTS_DIR);
    const bytes = (await dirSize(root)) ?? 0;
    try {
        await vscode.workspace.fs.delete(root, {
            recursive: true,
            useTrash: false,
        });
    } catch {
        // best-effort
    }
    return bytes;
}

/**
 * Convenience: parent fsPath of `globalStorageUri` so the "Open cache
 * folder" QuickPick row can show a sensible detail line on all OSes.
 */
export function cacheFolderLabel(context: vscode.ExtensionContext): string {
    return path.normalize(context.globalStorageUri.fsPath);
}
