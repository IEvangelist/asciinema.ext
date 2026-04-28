import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import type { ExtractedArtifact } from "./zip-extract.js";
import type { WorkflowArtifact, WorkflowRunSummary } from "./github-client.js";
import type { PullRequestCoordinates } from "./parse-pr-url.js";

export interface RecentArtifact {
    readonly key: string;
    readonly coords: PullRequestCoordinates;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: ExtractedArtifact;
    readonly downloadedAt: number;
}

const STORAGE_KEY = "asciinema.recentArtifacts.v1";
const MAX_RECENTS = 25;

let cache = new Map<string, RecentArtifact>();
let storage: vscode.Memento | undefined;

function makeKey(
    coords: PullRequestCoordinates,
    artifactId: number
): string {
    return `${coords.owner}/${coords.repo}#${coords.number}::${artifactId}`;
}

interface StoredRecent {
    readonly key: string;
    readonly coords: PullRequestCoordinates;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: {
        readonly rootDir: string; // serialized URI
        readonly files: string[];
        readonly totalBytes: number;
    };
    readonly downloadedAt: number;
}

function serialize(entry: RecentArtifact): StoredRecent {
    return {
        key: entry.key,
        coords: entry.coords,
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

function deserialize(s: StoredRecent): RecentArtifact {
    return {
        key: s.key,
        coords: s.coords,
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
 */
export async function initRecentArtifacts(
    context: vscode.ExtensionContext
): Promise<void> {
    storage = context.globalState;
    let stored: StoredRecent[] = [];
    try {
        stored = storage.get<StoredRecent[]>(STORAGE_KEY, []) ?? [];
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
 * invocation of the command can offer it as a "recent" entry instead of
 * re-downloading. Persists to globalState.
 */
export async function recordRecent(
    entry: Omit<RecentArtifact, "key" | "downloadedAt">
): Promise<RecentArtifact> {
    const key = makeKey(entry.coords, entry.artifact.id);
    const stored: RecentArtifact = {
        ...entry,
        key,
        downloadedAt: Date.now(),
    };
    cache.set(key, stored);
    // Cap to MAX_RECENTS, evicting oldest.
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
