import { createHash } from "node:crypto";

const MAX_BASENAME_LENGTH = 80;

/**
 * Produces a deterministic, filesystem-safe filename for a .cast file
 * extracted from a zip, preserving uniqueness across collisions.
 *
 * Format: `<12-char-sha256-of-full-relpath>-<sanitized-basename>.cast`
 *
 * Two different paths that share a basename (e.g., `a/foo.cast` and
 * `b/foo.cast`) will produce different filenames because the hash is
 * derived from the full relative path. Path components themselves are
 * never written to disk, so traversal (`../foo.cast`) is structurally
 * impossible.
 */
export function sanitizeCastFileName(relPath: string): string {
    const normalized = relPath.replace(/\\/g, "/").trim();
    if (normalized.length === 0) {
        throw new Error("empty cast path");
    }

    const hash = createHash("sha256")
        .update(normalized)
        .digest("hex")
        .slice(0, 12);

    const lastSegment = normalized.split("/").pop() ?? "file.cast";
    const withoutExt = lastSegment.replace(/\.cast$/i, "");

    const safeBase = withoutExt
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, MAX_BASENAME_LENGTH);

    const finalBase = safeBase.length > 0 ? safeBase : "cast";

    return `${hash}-${finalBase}.cast`;
}
