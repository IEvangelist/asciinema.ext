import * as path from "node:path";

/**
 * Resolves `entryName` against `destFsPath` and returns the relative path if
 * it stays inside the destination, or `undefined` if it would escape.
 *
 * Strips leading slashes/drive letters and rejects absolute paths and `..`
 * traversal. Pure (no `vscode` dependency) so it can be unit-tested in
 * isolation.
 */
export function safeJoinRelative(
    destFsPath: string,
    entryName: string
): string | undefined {
    if (!entryName || entryName.length === 0) {
        return undefined;
    }
    let normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.length === 0) {
        return undefined;
    }
    if (/^[A-Za-z]:/.test(normalized)) {
        return undefined;
    }
    if (normalized.split("/").some((seg) => seg === "..")) {
        return undefined;
    }
    const resolved = path.resolve(destFsPath, normalized);
    const rel = path.relative(destFsPath, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return undefined;
    }
    return rel;
}
