import * as path from "node:path";

export interface SiteDetection {
    /**
     * Posix-style relative path of the directory containing the picked
     * `index.html`. Either `"."` (root) or a slash-joined subdirectory
     * (e.g. `"dist"`, `"out/site"`).
     */
    readonly siteRel: string;
    /** Posix-style path of the `index.html` relative to the artifact root. */
    readonly indexRelPath: string;
    /** Number of files under the resolved site root. */
    readonly fileCount: number;
}

export interface DetectStaticSiteInput {
    readonly files: readonly string[];
}

/**
 * Scans an artifact listing for an `index.html`. Returns `undefined` when
 * none is present. Picks the shallowest match (then alphabetic) so
 * artifacts like `dist/index.html` win over `dist/sub/page/index.html`.
 *
 * Pure path filtering — does not touch the filesystem. The result is
 * expressed in posix-relative terms so it can be consumed by both the
 * zip-backed HTTP server (which keys off entry paths) and the legacy
 * disk-backed server (which resolves the relative path against the
 * extracted root).
 */
export function detectStaticSite(
    input: DetectStaticSiteInput
): SiteDetection | undefined {
    const indexPaths = input.files.filter(
        (rel) => path.posix.basename(rel).toLowerCase() === "index.html"
    );
    if (indexPaths.length === 0) {
        return undefined;
    }
    indexPaths.sort((a, b) => {
        const da = a.split("/").length;
        const db = b.split("/").length;
        return da !== db ? da - db : a.localeCompare(b);
    });
    const indexRelPath = indexPaths[0];
    const siteRel = path.posix.dirname(indexRelPath);
    const fileCount = countFilesUnder(input.files, siteRel);
    return { siteRel, indexRelPath, fileCount };
}

function countFilesUnder(
    files: readonly string[],
    siteRel: string
): number {
    if (siteRel === ".") {
        return files.length;
    }
    const prefix = `${siteRel}/`;
    let count = 0;
    for (const rel of files) {
        if (rel === siteRel || rel.startsWith(prefix)) {
            count++;
        }
    }
    return count;
}
