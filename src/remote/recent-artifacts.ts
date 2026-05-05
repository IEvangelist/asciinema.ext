import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import type { ExtractedArtifact } from "./zip-extract.js";
import type { WorkflowArtifact, WorkflowRunSummary } from "./github-client.js";
import type { ArtifactSource } from "./artifact-source.js";
import type { PullRequestCoordinates } from "./parse-pr-url.js";

export interface RecentArtifact {
    readonly key: string;
    readonly source: ArtifactSource;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: ExtractedArtifact;
    readonly downloadedAt: number;
}

const STORAGE_KEY = "asciinema.recentArtifacts.v1";
const MAX_RECENTS = 25;

let cache = new Map<string, RecentArtifact>();
let storage: vscode.Memento | undefined;

/**
 * Stable key for a recent entry. Includes the source kind, run id, and
 * artifact id so PR-sourced and run-sourced entries can never collide even
 * when they reference the same underlying artifact.
 */
function makeKey(source: ArtifactSource, runId: number, artifactId: number): string {
    if (source.kind === "pr") {
        return `${source.coords.owner}/${source.coords.repo}::pr${source.coords.number}::run${runId}::artifact${artifactId}`;
    }
    return `${source.coords.owner}/${source.coords.repo}::run${runId}::artifact${artifactId}`;
}

interface StoredRecentV2 {
    readonly key: string;
    readonly source: ArtifactSource;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: {
        readonly rootDir: string; // serialized URI
        readonly files: string[];
        readonly totalBytes: number;
    };
    readonly downloadedAt: number;
}

/**
 * Pre-discriminated-source schema used before the run-URL command landed.
 * Recognized at deserialize time and converted into the v2 shape with
 * `source: { kind: "pr", coords }`.
 */
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

type AnyStoredRecent = StoredRecentV2 | StoredRecentV1;

function isV2(s: AnyStoredRecent): s is StoredRecentV2 {
    return (s as StoredRecentV2).source !== undefined;
}

function serialize(entry: RecentArtifact): StoredRecentV2 {
    return {
        key: entry.key,
        source: entry.source,
        run: entry.run,
        artifact: entry.artifact,
        extracted: {
            rootDir: entry.extracted.rootDir.toString(),
            files: entry.extracted.files,
            totalBytes: entry.extracted.totalBytes,
        },
        downloadedAt: entry.downloadedAt,
    };
}

function deserialize(s: AnyStoredRecent): RecentArtifact {
    const source: ArtifactSource = isV2(s)
        ? s.source
        : { kind: "pr", coords: s.coords };
    return {
        key: s.key,
        source,
        run: s.run,
        artifact: s.artifact,
        extracted: {
            rootDir: vscode.Uri.parse(s.extracted.rootDir),
            files: s.extracted.files,
            totalBytes: s.extracted.totalBytes,
        },
        downloadedAt: s.downloadedAt,
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
 * Hydrates the recents cache from `globalState` and prunes any entries whose
 * extraction directory no longer exists on disk. Must be called from the
 * extension's `activate` before any UI uses recents.
 *
 * Backward-compatible: legacy v1 entries (with `coords` instead of `source`)
 * are migrated in-memory to the v2 shape and re-persisted on the next write.
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
        // Prune entries whose directories are gone.
        await listRecent();
    } catch {
        // best-effort; keep cache as-is
    }
}

/**
 * Records a successfully downloaded + extracted artifact so the next
 * invocation of any artifacts command can offer it as a "recent" entry
 * instead of re-downloading. Persists to globalState.
 */
export async function recordRecent(
    entry: Omit<RecentArtifact, "key" | "downloadedAt">
): Promise<RecentArtifact> {
    const key = makeKey(entry.source, entry.run.id, entry.artifact.id);
    const stored: RecentArtifact = {
        ...entry,
        key,
        downloadedAt: Date.now(),
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
 * Returns recent artifacts (newest first) whose extraction directories are
 * still present on disk. Stale entries are pruned in-place and persisted.
 */
export async function listRecent(): Promise<RecentArtifact[]> {
    const all = [...cache.values()].sort(
        (a, b) => b.downloadedAt - a.downloadedAt
    );
    const live: RecentArtifact[] = [];
    let pruned = false;
    for (const entry of all) {
        try {
            const stat = await fs.stat(entry.extracted.rootDir.fsPath);
            if (stat.isDirectory()) {
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

/**
 * Removes a recent entry and (best-effort) deletes its on-disk artifact
 * directory.
 */
export async function removeRecent(key: string): Promise<void> {
    const entry = cache.get(key);
    cache.delete(key);
    await persist();
    if (entry) {
        try {
            await vscode.workspace.fs.delete(entry.extracted.rootDir, {
                recursive: true,
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
 * Returns the set of artifact directory fsPaths currently referenced by
 * recents. Useful for orphan cleanup on startup.
 */
export function getKnownArtifactDirs(): Set<string> {
    return new Set([...cache.values()].map((e) => e.extracted.rootDir.fsPath));
}
