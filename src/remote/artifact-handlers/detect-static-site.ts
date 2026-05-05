import * as path from "node:path";
import type { ExtractedArtifact } from "../zip-extract.js";

export interface SiteDetection {
    /** Directory inside the artifact containing the picked `index.html`. */
    readonly siteRoot: string;
    /** Posix-style path of the `index.html` relative to the artifact root. */
    readonly indexRelPath: string;
    /** Number of files under the resolved site root. */
    readonly fileCount: number;
}

/**
 * Scans an extracted artifact for an `index.html`. Returns `undefined`
 * when none is present. Picks the shallowest match (then alphabetic) so
 * artifacts like `dist/index.html` win over `dist/sub/page/index.html`.
 */
export async function detectStaticSite(
    extracted: ExtractedArtifact
): Promise<SiteDetection | undefined> {
    const indexPaths = extracted.files.filter(
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
    const siteRoot =
        siteRel === "."
            ? extracted.rootDir.fsPath
            : path.join(extracted.rootDir.fsPath, ...siteRel.split("/"));

    const fileCount = countFilesUnder(extracted.files, siteRel);

    return { siteRoot, indexRelPath, fileCount };
}

function countFilesUnder(files: readonly string[], siteRel: string): number {
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
