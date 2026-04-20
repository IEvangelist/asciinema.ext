import JSZip from "jszip";

export interface CastEntry {
    readonly path: string;
    readonly bytes: Uint8Array;
}

export interface ZipExtractionLimits {
    readonly maxEntries: number;
    readonly maxEntryBytes: number;
    readonly maxTotalCastBytes: number;
}

export const DEFAULT_LIMITS: ZipExtractionLimits = {
    maxEntries: 500,
    maxEntryBytes: 10 * 1024 * 1024,
    maxTotalCastBytes: 50 * 1024 * 1024,
};

export class ZipLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ZipLimitError";
    }
}

/**
 * Loads a zip from in-memory bytes and returns every entry whose name ends
 * in `.cast`. Inflates only matching entries; skips the rest.
 *
 * Enforces, in order:
 *   1. Total entry count across the archive.
 *   2. Per-entry uncompressed size for each `.cast` entry.
 *   3. Total uncompressed size summed across all `.cast` entries.
 *
 * Any breach raises `ZipLimitError` with a message citing the specific cap.
 * Path traversal is not a concern here — we return paths to the caller but
 * never use them directly as filesystem paths.
 */
export async function extractCastEntries(
    zipBytes: Uint8Array,
    limits: ZipExtractionLimits = DEFAULT_LIMITS
): Promise<CastEntry[]> {
    const zip = await JSZip.loadAsync(zipBytes);

    const allFiles = Object.values(zip.files).filter((f) => !f.dir);
    if (allFiles.length > limits.maxEntries) {
        throw new ZipLimitError(
            `Artifact has ${allFiles.length} entries, exceeding the ${limits.maxEntries} entry cap.`
        );
    }

    const castFiles = allFiles.filter((f) =>
        f.name.toLowerCase().endsWith(".cast")
    );

    const entries: CastEntry[] = [];
    let runningTotal = 0;

    for (const file of castFiles) {
        const bytes = await file.async("uint8array");

        if (bytes.byteLength > limits.maxEntryBytes) {
            throw new ZipLimitError(
                `Cast entry "${file.name}" is ${Math.round(
                    bytes.byteLength / 1024 / 1024
                )} MB, exceeding the ${Math.round(
                    limits.maxEntryBytes / 1024 / 1024
                )} MB per-entry cap.`
            );
        }

        runningTotal += bytes.byteLength;
        if (runningTotal > limits.maxTotalCastBytes) {
            throw new ZipLimitError(
                `Total uncompressed cast content exceeds the ${Math.round(
                    limits.maxTotalCastBytes / 1024 / 1024
                )} MB cap.`
            );
        }

        entries.push({ path: file.name, bytes });
    }

    return entries;
}
