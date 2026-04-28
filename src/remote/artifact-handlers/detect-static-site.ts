import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ExtractedArtifact } from "../zip-extract.js";

export interface SiteDetection {
    /** Directory inside the artifact containing the picked `index.html`. */
    readonly siteRoot: string;
    /** Posix-style path of the `index.html` relative to the artifact root. */
    readonly indexRelPath: string;
    /** True when at least one Astro-specific marker was found. */
    readonly isAstro: boolean;
    /** Human-readable explanations of the markers we matched. */
    readonly astroMarkers: string[];
    /** Number of files under the resolved site root. */
    readonly fileCount: number;
}

/**
 * Scans an extracted artifact for a static site and reports whether it looks
 * like an Astro build. Returns `undefined` when no `index.html` is present.
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
    // Prefer the shallowest index.html; tie-break alphabetically for stability.
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

    const astroMarkers = await collectAstroMarkers(
        extracted,
        siteRel,
        indexRelPath
    );
    const fileCount = countFilesUnder(extracted.files, siteRel);

    return {
        siteRoot,
        indexRelPath,
        isAstro: astroMarkers.length > 0,
        astroMarkers,
        fileCount,
    };
}

async function collectAstroMarkers(
    extracted: ExtractedArtifact,
    siteRel: string,
    indexRelPath: string
): Promise<string[]> {
    const markers: string[] = [];

    // Marker 1: _astro/ subdirectory under the site root.
    const astroDirPrefix = siteRel === "." ? "_astro/" : `${siteRel}/_astro/`;
    if (extracted.files.some((rel) => rel.startsWith(astroDirPrefix))) {
        markers.push("_astro/ asset directory present");
    }

    // Marker 2: any package.json at site root or any ancestor (within the
    // extracted artifact only) declares an `astro` dependency.
    const packageJsonRel = findAncestorPackageJson(extracted.files, siteRel);
    if (packageJsonRel) {
        const pkgAbs = path.join(
            extracted.rootDir.fsPath,
            ...packageJsonRel.split("/")
        );
        const astroVersion = await readAstroDepVersion(pkgAbs);
        if (astroVersion) {
            markers.push(
                `${packageJsonRel} declares astro@${astroVersion}`
            );
        }
    }

    // Marker 3: index.html contains a generator meta tag for Astro.
    const indexAbs = path.join(
        extracted.rootDir.fsPath,
        ...indexRelPath.split("/")
    );
    try {
        const fd = await fs.open(indexAbs, "r");
        try {
            // The meta tag is inside <head>; 16 KB is plenty.
            const buf = Buffer.alloc(16 * 1024);
            const { bytesRead } = await fd.read(buf, 0, buf.byteLength, 0);
            const text = buf
                .subarray(0, bytesRead)
                .toString("utf8")
                .toLowerCase();
            const generatorRe =
                /<meta[^>]+name=["']generator["'][^>]+content=["']astro([^"']*)["']/i;
            const match = generatorRe.exec(text);
            if (match) {
                markers.push(
                    `index.html generator meta tag (astro${match[1] ?? ""})`
                );
            }
        } finally {
            await fd.close();
        }
    } catch {
        // ignore
    }

    return markers;
}

function findAncestorPackageJson(
    files: readonly string[],
    siteRel: string
): string | undefined {
    const segments = siteRel === "." ? [] : siteRel.split("/");
    // Try site root first, then each ancestor up to the artifact root.
    const candidates: string[] = [];
    for (let i = segments.length; i >= 0; i--) {
        const dir = segments.slice(0, i).join("/");
        candidates.push(dir === "" ? "package.json" : `${dir}/package.json`);
    }
    for (const candidate of candidates) {
        if (files.includes(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

async function readAstroDepVersion(
    pkgAbsPath: string
): Promise<string | undefined> {
    try {
        const text = await fs.readFile(pkgAbsPath, "utf8");
        const json = JSON.parse(text) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
        };
        return (
            json.dependencies?.astro ??
            json.devDependencies?.astro ??
            json.peerDependencies?.astro
        );
    } catch {
        return undefined;
    }
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
