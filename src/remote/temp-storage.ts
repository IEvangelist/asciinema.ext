import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { sanitizeCastFileName } from "./sanitize.js";
import {
    DEFAULT_DISK_LIMITS,
    extractZipToDir,
    type DiskExtractionLimits,
    type ExtractedArtifact,
    type ExtractionProgress,
} from "./zip-extract.js";
import {
    peekArtifactBundle,
    type ArtifactBundle,
} from "./artifact-bundle.js";

const ROOT_DIR_NAME = "remote-casts";
const ARTIFACTS_ROOT_DIR_NAME = "remote-artifacts";

let sessionId: string | undefined;

function getSessionId(): string {
    if (!sessionId) {
        sessionId = randomUUID();
    }
    return sessionId;
}

function getSessionDir(context: vscode.ExtensionContext): vscode.Uri {
    return vscode.Uri.joinPath(
        context.globalStorageUri,
        ROOT_DIR_NAME,
        getSessionId()
    );
}

function getArtifactsRoot(
    context: vscode.ExtensionContext
): vscode.Uri {
    return vscode.Uri.joinPath(
        context.globalStorageUri,
        ARTIFACTS_ROOT_DIR_NAME
    );
}

/**
 * Returns the cached zip URI for `artifactId`. The file may or may not
 * exist yet — callers create it via {@link saveArtifactZip}.
 */
export function getArtifactZipUri(
    context: vscode.ExtensionContext,
    artifactId: number
): vscode.Uri {
    return vscode.Uri.joinPath(
        getArtifactsRoot(context),
        `${artifactId}.zip`
    );
}

/**
 * Returns the cached extracted directory for `artifactId`. May or may not
 * exist on disk depending on whether the dispatcher ran an extraction.
 */
export function getArtifactExtractedDir(
    context: vscode.ExtensionContext,
    artifactId: number
): vscode.Uri {
    return vscode.Uri.joinPath(
        getArtifactsRoot(context),
        String(artifactId)
    );
}

/**
 * Best-effort cleanup of the current VS Code session's temp `.cast` files.
 * Called from `deactivate`. Artifact extractions and zips are intentionally
 * NOT removed here — they are persisted across sessions so the "Recent"
 * picker can re-open them. Errors are swallowed.
 */
export async function cleanupCurrentSession(
    context: vscode.ExtensionContext
): Promise<void> {
    try {
        await vscode.workspace.fs.delete(getSessionDir(context), {
            recursive: true,
            useTrash: false,
        });
    } catch {
        // best-effort
    }
}

/**
 * Best-effort cleanup of temp directories from previous VS Code sessions.
 *
 * Deletes sibling session dirs under `remote-casts/` (one-off cast files
 * have no persisted recents) and removes orphaned `remote-artifacts/*`
 * entries (either `{id}/` directories or `{id}.zip` files) that aren't
 * referenced by `knownArtifactPaths`.
 */
export async function cleanupOlderSessions(
    context: vscode.ExtensionContext,
    knownArtifactPaths: ReadonlySet<string>
): Promise<void> {
    await Promise.all([
        cleanupSiblingSessions(
            context,
            ROOT_DIR_NAME,
            getSessionDir(context)
        ),
        cleanupOrphanArtifacts(context, knownArtifactPaths),
    ]);
}

async function cleanupOrphanArtifacts(
    context: vscode.ExtensionContext,
    knownArtifactPaths: ReadonlySet<string>
): Promise<void> {
    const root = getArtifactsRoot(context);
    try {
        const entries = await vscode.workspace.fs.readDirectory(root);
        await Promise.all(
            entries.map(async ([name, type]) => {
                const candidate = vscode.Uri.joinPath(root, name);
                if (knownArtifactPaths.has(candidate.fsPath)) {
                    return;
                }
                if (
                    type !== vscode.FileType.Directory &&
                    type !== vscode.FileType.File
                ) {
                    return;
                }
                try {
                    await vscode.workspace.fs.delete(candidate, {
                        recursive: type === vscode.FileType.Directory,
                        useTrash: false,
                    });
                } catch {
                    // best-effort
                }
            })
        );
    } catch {
        // root absent — nothing to clean
    }
}

async function cleanupSiblingSessions(
    context: vscode.ExtensionContext,
    rootName: string,
    currentSessionDir: vscode.Uri
): Promise<void> {
    const root = vscode.Uri.joinPath(context.globalStorageUri, rootName);
    try {
        const entries = await vscode.workspace.fs.readDirectory(root);
        await Promise.all(
            entries.map(async ([name, type]) => {
                if (type !== vscode.FileType.Directory) {
                    return;
                }
                const candidate = vscode.Uri.joinPath(root, name);
                if (candidate.toString() === currentSessionDir.toString()) {
                    return;
                }
                try {
                    await vscode.workspace.fs.delete(candidate, {
                        recursive: true,
                        useTrash: false,
                    });
                } catch {
                    // best-effort
                }
            })
        );
    } catch {
        // Root didn't exist or couldn't be read — nothing to clean.
    }
}

/**
 * Writes a downloaded .cast payload into the current session's temp dir.
 * The returned URI is suitable for `vscode.openWith`.
 */
export async function writeTempCast(
    context: vscode.ExtensionContext,
    relPath: string,
    bytes: Uint8Array
): Promise<vscode.Uri> {
    const sessionDir = getSessionDir(context);
    await vscode.workspace.fs.createDirectory(sessionDir);

    const fileName = sanitizeCastFileName(relPath);
    const fileUri = vscode.Uri.joinPath(sessionDir, fileName);
    await vscode.workspace.fs.writeFile(fileUri, bytes);
    return fileUri;
}

export interface SaveArtifactZipOptions {
    readonly maxEntries: number;
}

/**
 * Writes the downloaded zip bytes to `remote-artifacts/{id}.zip` and
 * peeks the central directory to build an {@link ArtifactBundle}.
 *
 * Replaces any existing extraction directory or stale zip at the same id
 * so a re-download produces a clean state. Throws `ZipLimitError` (via
 * `peekArtifactBundle`) on entry-count breaches or unsafe entry names.
 */
export async function saveArtifactZip(
    context: vscode.ExtensionContext,
    artifactId: number,
    zipBytes: Uint8Array,
    options: SaveArtifactZipOptions
): Promise<ArtifactBundle> {
    const sessionRoot = getArtifactsRoot(context);
    await vscode.workspace.fs.createDirectory(sessionRoot);

    // Wipe any stale state for this artifact id (extracted dir from an
    // earlier version, or a previous partial zip).
    const extractedDir = getArtifactExtractedDir(context, artifactId);
    try {
        await vscode.workspace.fs.delete(extractedDir, {
            recursive: true,
            useTrash: false,
        });
    } catch {
        // not present — fine
    }

    const zipUri = getArtifactZipUri(context, artifactId);
    await vscode.workspace.fs.writeFile(zipUri, zipBytes);

    const peeked = await peekArtifactBundle(zipBytes, {
        maxEntries: options.maxEntries,
    });

    return {
        zipPath: zipUri,
        files: peeked.files,
        zipSizeBytes: zipBytes.byteLength,
    };
}

/**
 * Best-effort delete of a cached artifact zip. Used after a non-HTML
 * handler has extracted the zip to disk — at that point the extracted
 * tree is the source of truth and the zip is just redundant cache weight.
 */
export async function deleteArtifactZip(
    context: vscode.ExtensionContext,
    artifactId: number
): Promise<void> {
    const zipUri = getArtifactZipUri(context, artifactId);
    try {
        await vscode.workspace.fs.delete(zipUri, { useTrash: false });
    } catch {
        // best-effort
    }
}

/**
 * Inflates an artifact zip into a per-artifact directory under the shared
 * `remote-artifacts/` root. Returns the extraction root + listing.
 *
 * When `resume` is true (e.g. retrying after the user raised a cap), the
 * existing directory is kept intact and already-written files are skipped
 * so we pick up where we left off instead of starting over.
 */
export async function extractArtifactToDisk(
    context: vscode.ExtensionContext,
    artifactId: number,
    zipBytes: Uint8Array,
    limits: DiskExtractionLimits = DEFAULT_DISK_LIMITS,
    onProgress?: (p: ExtractionProgress) => void,
    resume = false,
    signal?: AbortSignal
): Promise<ExtractedArtifact> {
    const sessionRoot = getArtifactsRoot(context);
    await vscode.workspace.fs.createDirectory(sessionRoot);
    const artifactDir = getArtifactExtractedDir(context, artifactId);

    if (!resume) {
        // Start fresh: wipe any prior partial extraction so re-downloads
        // produce a clean tree.
        try {
            await vscode.workspace.fs.delete(artifactDir, {
                recursive: true,
                useTrash: false,
            });
        } catch {
            // not present yet — fine
        }
    }

    return await extractZipToDir(zipBytes, artifactDir, {
        limits,
        onProgress,
        resume,
        signal,
    });
}
