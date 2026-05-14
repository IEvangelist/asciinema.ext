import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import type { ExtractedArtifact } from "./zip-extract.js";
import type { ArtifactBundle } from "./artifact-bundle.js";
import type { WorkflowArtifact, WorkflowRunSummary } from "./github-client.js";
import type { ArtifactSource } from "./artifact-source.js";
import type { PullRequestCoordinates } from "./parse-pr-url.js";

/**
 * Storage shape for a recent artifact. Discriminated on `kind`:
 *
 *  - `"zip"`: cached as a single `.zip` file. The HTML preview path
 *    streams from this directly via JSZip; the cast / browse path
 *    inflates it on demand (and the dispatcher then deletes the zip,
 *    swapping the recent over to the `"extracted"` variant).
 *  - `"extracted"`: cached as an on-disk directory tree. Either a
 *    legacy v2 recent (extraction was eager), or a v3 recent that
 *    started life as a zip and has since been inflated.
 */
export type RecentArtifact = RecentArtifactBase &
    (
        | { readonly kind: "zip"; readonly bundle: ArtifactBundle }
        | { readonly kind: "extracted"; readonly extracted: ExtractedArtifact }
    );

interface RecentArtifactBase {
    readonly key: string;
    readonly source: ArtifactSource;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly downloadedAt: number;
}

const STORAGE_KEY = "asciinema.recentArtifacts.v1";
const MAX_RECENTS = 25;

let cache = new Map<string, RecentArtifact>();
let storage: vscode.Memento | undefined;

function makeKey(
    source: ArtifactSource,
    runId: number,
    artifactId: number
): string {
    if (source.kind === "pr") {
        return `${source.coords.owner}/${source.coords.repo}::pr${source.coords.number}::run${runId}::artifact${artifactId}`;
    }
    return `${source.coords.owner}/${source.coords.repo}::run${runId}::artifact${artifactId}`;
}

interface StoredRecentV3Base {
    readonly key: string;
    readonly source: ArtifactSource;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly downloadedAt: number;
}

type StoredRecentV3 = StoredRecentV3Base &
    (
        | {
              readonly kind: "zip";
              readonly bundle: {
                  readonly zipPath: string;
                  readonly files: string[];
                  readonly zipSizeBytes: number;
              };
          }
        | {
              readonly kind: "extracted";
              readonly extracted: {
                  readonly rootDir: string;
                  readonly files: string[];
                  readonly totalBytes: number;
              };
          }
    );

/** Pre-v3: extraction-only schema with `source`. */
interface StoredRecentV2 {
    readonly key: string;
    readonly source: ArtifactSource;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: {
        readonly rootDir: string;
        readonly files: string[];
        readonly totalBytes: number;
    };
    readonly downloadedAt: number;
}

/** Pre-v2: PR-only schema (no `source` field, just `coords`). */
interface StoredRecentV1 {
    readonly key: string;
    readonly coords: PullRequestCoordinates;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: {
        readonly rootDir: string;
        readonly files: string[];
        readonly totalBytes: number;
    };
    readonly downloadedAt: number;
}

type AnyStoredRecent = StoredRecentV3 | StoredRecentV2 | StoredRecentV1;

function isV3(s: AnyStoredRecent): s is StoredRecentV3 {
    return (
        typeof (s as StoredRecentV3).kind === "string" &&
        ((s as StoredRecentV3).kind === "zip" ||
            (s as StoredRecentV3).kind === "extracted")
    );
}

function isV2(s: AnyStoredRecent): s is StoredRecentV2 {
    return (s as StoredRecentV2).source !== undefined && !isV3(s);
}

function serialize(entry: RecentArtifact): StoredRecentV3 {
    const base: StoredRecentV3Base = {
        key: entry.key,
        source: entry.source,
        run: entry.run,
        artifact: entry.artifact,
        downloadedAt: entry.downloadedAt,
    };
    if (entry.kind === "zip") {
        return {
            ...base,
            kind: "zip",
            bundle: {
                zipPath: entry.bundle.zipPath.toString(),
                files: entry.bundle.files,
                zipSizeBytes: entry.bundle.zipSizeBytes,
            },
        };
    }
    return {
        ...base,
        kind: "extracted",
        extracted: {
            rootDir: entry.extracted.rootDir.toString(),
            files: entry.extracted.files,
            totalBytes: entry.extracted.totalBytes,
        },
    };
}

function deserialize(s: AnyStoredRecent): RecentArtifact {
    if (isV3(s)) {
        const base = {
            key: s.key,
            source: s.source,
            run: s.run,
            artifact: s.artifact,
            downloadedAt: s.downloadedAt,
        };
        if (s.kind === "zip") {
            return {
                ...base,
                kind: "zip",
                bundle: {
                    zipPath: vscode.Uri.parse(s.bundle.zipPath),
                    files: s.bundle.files,
                    zipSizeBytes: s.bundle.zipSizeBytes,
                },
            };
        }
        return {
            ...base,
            kind: "extracted",
            extracted: {
                rootDir: vscode.Uri.parse(s.extracted.rootDir),
                files: s.extracted.files,
                totalBytes: s.extracted.totalBytes,
            },
        };
    }

    // v2 / v1 — always extracted-shape with a possibly-missing source.
    const source: ArtifactSource = isV2(s)
        ? s.source
        : { kind: "pr", coords: (s as StoredRecentV1).coords };
    return {
        key: s.key,
        source,
        run: s.run,
        artifact: s.artifact,
        downloadedAt: s.downloadedAt,
        kind: "extracted",
        extracted: {
            rootDir: vscode.Uri.parse(s.extracted.rootDir),
            files: s.extracted.files,
            totalBytes: s.extracted.totalBytes,
        },
    };
}

async function persist(): Promise<void> {
    if (!storage) {
        return;
    }
    const arr = [...cache.values()].map(serialize);
    await storage.update(STORAGE_KEY, arr);
}

/**
 * Hydrates the recents cache from `globalState` and prunes any entries
 * whose backing storage (zip or directory) no longer exists. Must be
 * called from the extension's `activate` before any UI uses recents.
 *
 * Backward-compatible: legacy v1/v2 entries deserialize into the v3
 * `"extracted"` variant and get re-persisted on the next write.
 */
export async function initRecentArtifacts(
    context: vscode.ExtensionContext
): Promise<void> {
    storage = context.globalState;
    let stored: AnyStoredRecent[] = [];
    try {
        stored = storage.get<AnyStoredRecent[]>(STORAGE_KEY, []) ?? [];
        if (!Array.isArray(stored)) {
            stored = [];
        }
    } catch {
        stored = [];
    }
    cache = new Map();
    for (const s of stored) {
        try {
            if (!s || typeof s !== "object" || typeof s.key !== "string") {
                continue;
            }
            cache.set(s.key, deserialize(s));
        } catch {
            // skip malformed entries
        }
    }
    try {
        await listRecent();
    } catch {
        // best-effort
    }
}

export type RecordRecentInput =
    | {
          readonly source: ArtifactSource;
          readonly run: WorkflowRunSummary;
          readonly artifact: WorkflowArtifact;
          readonly bundle: ArtifactBundle;
      }
    | {
          readonly source: ArtifactSource;
          readonly run: WorkflowRunSummary;
          readonly artifact: WorkflowArtifact;
          readonly extracted: ExtractedArtifact;
      };

/**
 * Records a successfully downloaded artifact. Pass `bundle` for the
 * fast-path (zip cached, not yet extracted) or `extracted` for legacy
 * eager-extraction paths (no longer used by the live flow, but kept for
 * test ergonomics and future extensions).
 */
export async function recordRecent(
    entry: RecordRecentInput
): Promise<RecentArtifact> {
    const key = makeKey(entry.source, entry.run.id, entry.artifact.id);
    const downloadedAt = Date.now();
    const stored: RecentArtifact =
        "bundle" in entry
            ? {
                  key,
                  source: entry.source,
                  run: entry.run,
                  artifact: entry.artifact,
                  downloadedAt,
                  kind: "zip",
                  bundle: entry.bundle,
              }
            : {
                  key,
                  source: entry.source,
                  run: entry.run,
                  artifact: entry.artifact,
                  downloadedAt,
                  kind: "extracted",
                  extracted: entry.extracted,
              };
    cache.set(key, stored);
    if (cache.size > MAX_RECENTS) {
        const sorted = [...cache.values()].sort(
            (a, b) => b.downloadedAt - a.downloadedAt
        );
        cache = new Map(sorted.slice(0, MAX_RECENTS).map((e) => [e.key, e]));
    }
    await persist();
    return stored;
}

/**
 * Returns recent artifacts (newest first) whose backing storage is still
 * present on disk. Stale entries are pruned in-place and persisted.
 */
export async function listRecent(): Promise<RecentArtifact[]> {
    const all = [...cache.values()].sort(
        (a, b) => b.downloadedAt - a.downloadedAt
    );
    const live: RecentArtifact[] = [];
    let pruned = false;
    for (const entry of all) {
        const path = backingPath(entry);
        try {
            const stat = await fs.stat(path);
            if (entry.kind === "zip" ? stat.isFile() : stat.isDirectory()) {
                live.push(entry);
                continue;
            }
        } catch {
            // missing — drop
        }
        cache.delete(entry.key);
        pruned = true;
    }
    if (pruned) {
        await persist();
    }
    return live;
}

function backingPath(entry: RecentArtifact): string {
    return entry.kind === "zip"
        ? entry.bundle.zipPath.fsPath
        : entry.extracted.rootDir.fsPath;
}

/**
 * Returns the URI of the on-disk backing file (zip-kind) or directory
 * (extracted-kind) for a recent entry.
 */
export function backingUri(entry: RecentArtifact): vscode.Uri {
    return entry.kind === "zip" ? entry.bundle.zipPath : entry.extracted.rootDir;
}

/**
 * Removes a recent entry and (best-effort) deletes its on-disk backing
 * file (`.zip`) or directory (extracted tree).
 */
export async function removeRecent(key: string): Promise<void> {
    const entry = cache.get(key);
    cache.delete(key);
    await persist();
    if (entry) {
        const target = backingUri(entry);
        try {
            await vscode.workspace.fs.delete(target, {
                recursive: entry.kind === "extracted",
                useTrash: false,
            });
        } catch {
            // best-effort
        }
    }
}

/** Test hook — clears in-memory cache (does not touch disk or storage). */
export function _resetRecentForTests(): void {
    cache = new Map();
    storage = undefined;
}

/**
 * Returns the set of artifact backing-path fsPaths currently referenced
 * by recents (zip files or extracted directories). Used for orphan
 * cleanup on startup.
 */
export function getKnownArtifactPaths(): Set<string> {
    return new Set([...cache.values()].map((e) => backingPath(e)));
}

/**
 * Bulk clear: removes every recent entry whose `downloadedAt >= sinceMs`,
 * deleting backing storage as it goes. Returns the bytes freed.
 *
 * Operates entirely in-memory + on-disk; safe to call when `globalState`
 * isn't yet initialized (e.g. early-init paths).
 */
export async function removeRecentsSince(
    sinceMs: number
): Promise<{ bytes: number; count: number }> {
    let bytes = 0;
    let count = 0;
    for (const entry of [...cache.values()]) {
        if (entry.downloadedAt < sinceMs) {
            continue;
        }
        const sz =
            entry.kind === "zip"
                ? entry.bundle.zipSizeBytes
                : entry.extracted.totalBytes;
        bytes += sz;
        count++;
        await removeRecent(entry.key);
    }
    return { bytes, count };
}

/**
 * Bulk clear: removes every recent entry and best-effort deletes their
 * backing storage. Returns the total bytes freed.
 */
export async function removeAllRecents(): Promise<{ bytes: number; count: number }> {
    let bytes = 0;
    let count = 0;
    for (const entry of [...cache.values()]) {
        const sz =
            entry.kind === "zip"
                ? entry.bundle.zipSizeBytes
                : entry.extracted.totalBytes;
        bytes += sz;
        count++;
        await removeRecent(entry.key);
    }
    return { bytes, count };
}

/**
 * Drops every recent from the cache without deleting backing storage.
 * Intended for the "clear artifacts root wholesale" path where the
 * caller is about to wipe `remote-artifacts/` directly.
 */
export async function forgetAllRecents(): Promise<void> {
    cache = new Map();
    await persist();
}

/**
 * Returns `{ min, max }` timestamps across all recents, or `undefined`
 * when there are none.
 */
export function recentsDateRange():
    | { min: number; max: number; count: number }
    | undefined {
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (const e of cache.values()) {
        if (e.downloadedAt < min) {
            min = e.downloadedAt;
        }
        if (e.downloadedAt > max) {
            max = e.downloadedAt;
        }
        count++;
    }
    if (count === 0) {
        return undefined;
    }
    return { min, max, count };
}
