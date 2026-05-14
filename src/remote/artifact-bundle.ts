import * as vscode from "vscode";
import JSZip from "jszip";
import { ZipLimitError } from "./artifact-zip.js";
import { safeJoinRelative } from "./safe-path.js";

/**
 * Lightweight, zip-backed view of a downloaded artifact.
 *
 * Built by {@link peekArtifactBundle} via a single `JSZip.loadAsync` call,
 * which parses the zip's central directory without decompressing any
 * entries. The bundle is suitable for everything that only needs the
 * archive *listing* (handler detection, the on-demand HTML server) and
 * intentionally carries no inflated bytes — callers that need an entry's
 * contents inflate it lazily through `JSZip` (HTML preview) or by running
 * the existing `extractZipToDir` (cast / browse fallback).
 */
export interface ArtifactBundle {
    /** Absolute path to the cached `.zip` on disk. */
    readonly zipPath: vscode.Uri;
    /** Posix-style relative paths of every entry (no directories). */
    readonly files: string[];
    /** Compressed `.zip` size on disk in bytes. */
    readonly zipSizeBytes: number;
}

export interface PeekArtifactBundleOptions {
    /**
     * Maximum number of entries permitted inside the zip. Mirrors the
     * `asciinema.maxArtifactEntryCount` setting. The peek itself never
     * decompresses entries — this is a defense against archives whose
     * central directory alone describes millions of files.
     */
    readonly maxEntries: number;
}

export interface PeekedZip {
    /** Posix-style entry paths, in central-directory order. */
    readonly files: string[];
}

/**
 * Parses an artifact zip's central directory and returns the entry listing.
 *
 * Enforces, in order:
 *   1. Total entry count.
 *   2. Symlink-style entries (Unix mode `0o120000`).
 *   3. Traversal-style entry names (`..`, absolute Windows paths,
 *      embedded NULs).
 *
 * Crucially, **no entry is decompressed here.** JSZip parses the zip
 * structure on `loadAsync`; per-entry inflation only happens when the
 * caller calls `entry.async(...)` later.
 */
export async function peekArtifactBundle(
    zipBytes: Uint8Array,
    options: PeekArtifactBundleOptions
): Promise<PeekedZip> {
    const zip = await JSZip.loadAsync(zipBytes);
    const allFiles = Object.values(zip.files).filter((f) => !f.dir);

    if (allFiles.length > options.maxEntries) {
        throw new ZipLimitError(
            `Artifact has ${allFiles.length.toLocaleString()} entries, exceeding the ${options.maxEntries.toLocaleString()} entry cap.`,
            "entries",
            options.maxEntries,
            allFiles.length
        );
    }

    const files: string[] = [];
    for (const file of allFiles) {
        const rawName = file.name;

        const mode =
            (file as unknown as { unixPermissions?: number }).unixPermissions ?? 0;
        if ((mode & 0o170000) === 0o120000) {
            throw new ZipLimitError(
                `Artifact contains a symlink entry "${rawName}", which is not supported for safety.`,
                "symlink"
            );
        }

        // Reject any entry whose name would escape an extraction root.
        // Even though the HTML server never writes to disk, traversal
        // resolution would also be unsafe at request-time — fail fast at
        // peek so dispatcher / handler code never sees a tainted listing.
        if (!safeJoinRelative("/tmp/peek", rawName)) {
            throw new ZipLimitError(
                `Artifact contains an unsafe path "${rawName}" that escapes the extraction root.`,
                "traversal"
            );
        }

        files.push(rawName.replace(/\\/g, "/"));
    }

    return { files };
}
