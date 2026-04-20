import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { sanitizeCastFileName } from "./sanitize.js";

const ROOT_DIR_NAME = "remote-casts";

let sessionId: string | undefined;

function getSessionDir(context: vscode.ExtensionContext): vscode.Uri {
    if (!sessionId) {
        sessionId = randomUUID();
    }
    return vscode.Uri.joinPath(
        context.globalStorageUri,
        ROOT_DIR_NAME,
        sessionId
    );
}

/**
 * Best-effort cleanup of temp-cast directories from previous VS Code sessions.
 *
 * Deletes sibling session dirs under `globalStorageUri/remote-casts/` but
 * leaves the current session's directory alone so restored tabs and
 * in-flight downloads aren't affected. Errors are swallowed.
 */
export async function cleanupOlderSessions(
    context: vscode.ExtensionContext
): Promise<void> {
    const root = vscode.Uri.joinPath(context.globalStorageUri, ROOT_DIR_NAME);
    const currentSessionDir = getSessionDir(context);

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
