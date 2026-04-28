import * as path from "node:path";
import * as vscode from "vscode";
import JSZip from "jszip";
import { ZipLimitError } from "./artifact-zip.js";
import { safeJoinRelative } from "./safe-path.js";

export { safeJoinRelative } from "./safe-path.js";

export interface DiskExtractionLimits {
    readonly maxEntries: number;
    readonly maxEntryBytes: number;
    readonly maxTotalBytes: number;
}

export const DEFAULT_DISK_LIMITS: DiskExtractionLimits = {
    maxEntries: 250_000,
    maxEntryBytes: 500 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export interface ExtractedArtifact {
    /** Absolute on-disk root containing the extracted files. */
    readonly rootDir: vscode.Uri;
    /** Posix-style relative paths of every extracted file (no directories). */
    readonly files: string[];
    /** Total uncompressed bytes written to disk. */
    readonly totalBytes: number;
}

export interface ExtractionProgress {
    /** Number of files written so far. */
    readonly filesWritten: number;
    /** Total number of files in the archive (known up front). */
    readonly totalFiles: number;
    /** Bytes written to disk so far. */
    readonly bytesWritten: number;
    /** Last entry name processed, for status messages. */
    readonly lastEntry: string;
}

/**
 * Inflates an entire artifact zip to disk under `destDir`.
 *
 * Enforces (in order):
 *   1. Total entry count
 *   2. Per-entry uncompressed size
 *   3. Aggregate uncompressed size across all entries
 *
 * Rejects entries whose normalized path would escape `destDir` (path
 * traversal). Rejects symlink-like entries (JSZip exposes Unix file mode bits
 * in `unixPermissions`; symlinks are mode 0o120000).
 */
export interface ExtractZipOptions {
    readonly limits?: DiskExtractionLimits;
    readonly onProgress?: (p: ExtractionProgress) => void;
    /**
     * When true, files already present at the destination with non-zero size
     * are kept as-is and counted toward `runningTotal` without re-decompressing
     * or re-writing. Use this to resume an extraction that aborted mid-way
     * (e.g. the user just raised a cap after a `ZipLimitError`).
     */
    readonly resume?: boolean;
}

export async function extractZipToDir(
    zipBytes: Uint8Array,
    destDir: vscode.Uri,
    limitsOrOptions:
        | DiskExtractionLimits
        | ExtractZipOptions = DEFAULT_DISK_LIMITS,
    onProgress?: (p: ExtractionProgress) => void
): Promise<ExtractedArtifact> {
    // Backwards-compatible signature: callers may still pass (limits, onProgress).
    const opts: ExtractZipOptions =
        "limits" in limitsOrOptions ||
        "onProgress" in limitsOrOptions ||
        "resume" in limitsOrOptions
            ? (limitsOrOptions as ExtractZipOptions)
            : {
                  limits: limitsOrOptions as DiskExtractionLimits,
                  onProgress,
              };
    const limits = opts.limits ?? DEFAULT_DISK_LIMITS;
    const progress = opts.onProgress ?? onProgress;
    const resume = opts.resume === true;

    const zip = await JSZip.loadAsync(zipBytes);
    const allFiles = Object.values(zip.files).filter((f) => !f.dir);

    if (allFiles.length > limits.maxEntries) {
        throw new ZipLimitError(
            `Artifact has ${allFiles.length.toLocaleString()} entries, exceeding the ${limits.maxEntries.toLocaleString()} entry cap.`,
            "entries",
            limits.maxEntries,
            allFiles.length
        );
    }

    await vscode.workspace.fs.createDirectory(destDir);
    const destFsPath = destDir.fsPath;
    const totalFiles = allFiles.length;

    const writtenFiles: string[] = [];
    let runningTotal = 0;

    for (const file of allFiles) {
        const rawName = file.name;

        // Symlink rejection (Unix mode bits 0o120000 == symlink).
        const mode =
            (file as unknown as { unixPermissions?: number }).unixPermissions ?? 0;
        if ((mode & 0o170000) === 0o120000) {
            throw new ZipLimitError(
                `Artifact contains a symlink entry "${rawName}", which is not supported for safety.`,
                "symlink"
            );
        }

        const safeRel = safeJoinRelative(destFsPath, rawName);
        if (!safeRel) {
            throw new ZipLimitError(
                `Artifact contains an unsafe path "${rawName}" that escapes the extraction root.`,
                "traversal"
            );
        }

        const fileUri = vscode.Uri.file(path.join(destFsPath, safeRel));

        // Resume fast path: if the destination already exists from a prior
        // partial run, trust it and skip the decompress + write.
        if (resume) {
            const existingSize = await statSize(fileUri);
            if (existingSize !== undefined && existingSize > 0) {
                if (existingSize > limits.maxEntryBytes) {
                    throw new ZipLimitError(
                        `Entry "${rawName}" is ${Math.round(
                            existingSize / 1024 / 1024
                        )} MB, exceeding the ${Math.round(
                            limits.maxEntryBytes / 1024 / 1024
                        )} MB per-entry cap.`,
                        "entrySize",
                        limits.maxEntryBytes,
                        existingSize
                    );
                }
                runningTotal += existingSize;
                if (runningTotal > limits.maxTotalBytes) {
                    throw new ZipLimitError(
                        `Total uncompressed artifact size exceeds the ${Math.round(
                            limits.maxTotalBytes / 1024 / 1024
                        )} MB cap.`,
                        "totalSize",
                        limits.maxTotalBytes,
                        runningTotal
                    );
                }
                writtenFiles.push(safeRel.split(path.sep).join("/"));
                progress?.({
                    filesWritten: writtenFiles.length,
                    totalFiles,
                    bytesWritten: runningTotal,
                    lastEntry: rawName,
                });
                continue;
            }
        }

        const bytes = await file.async("uint8array");
        if (bytes.byteLength > limits.maxEntryBytes) {
            throw new ZipLimitError(
                `Entry "${rawName}" is ${Math.round(
                    bytes.byteLength / 1024 / 1024
                )} MB, exceeding the ${Math.round(
                    limits.maxEntryBytes / 1024 / 1024
                )} MB per-entry cap.`,
                "entrySize",
                limits.maxEntryBytes,
                bytes.byteLength
            );
        }
        runningTotal += bytes.byteLength;
        if (runningTotal > limits.maxTotalBytes) {
            throw new ZipLimitError(
                `Total uncompressed artifact size exceeds the ${Math.round(
                    limits.maxTotalBytes / 1024 / 1024
                )} MB cap.`,
                "totalSize",
                limits.maxTotalBytes,
                runningTotal
            );
        }

        const parentUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(fileUri, bytes);

        writtenFiles.push(safeRel.split(path.sep).join("/"));

        progress?.({
            filesWritten: writtenFiles.length,
            totalFiles,
            bytesWritten: runningTotal,
            lastEntry: rawName,
        });
    }

    return {
        rootDir: destDir,
        files: writtenFiles,
        totalBytes: runningTotal,
    };
}

async function statSize(uri: vscode.Uri): Promise<number | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.File) {
            return stat.size;
        }
    } catch {
        // missing — not present
    }
    return undefined;
}

/**
 * Resolves `entryName` against `destDir` and returns the relative path if it
 * stays inside the destination, or `undefined` if it would escape.
 *
 * Re-exported from `./safe-path.js`; that module has no `vscode` dependency
 * and is unit-tested separately.
 */
