/**
 * Per-cast persisted player option overrides.
 *
 * Stored in `globalState` as a single `Record<uriString, PartialPlayerOptions>`
 * with an LRU cap so the map can't grow unbounded.
 */
import * as vscode from "vscode";
import {
    sanitize,
    type PartialPlayerOptions,
} from "./player-options.js";

const STORAGE_KEY = "asciinema.playerOverrides.v1";
const LRU_CAP = 200;

interface StoredEntry {
    readonly overrides: PartialPlayerOptions;
    readonly updatedAt: number;
}

type StoredMap = Record<string, StoredEntry>;

function readMap(context: vscode.ExtensionContext): StoredMap {
    const raw = context.globalState.get<StoredMap>(STORAGE_KEY) ?? {};
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const out: StoredMap = {};
    for (const [key, val] of Object.entries(raw)) {
        if (
            val &&
            typeof val === "object" &&
            "overrides" in val &&
            typeof (val as StoredEntry).updatedAt === "number"
        ) {
            out[key] = {
                overrides: sanitize((val as StoredEntry).overrides),
                updatedAt: (val as StoredEntry).updatedAt,
            };
        }
    }
    return out;
}

async function writeMap(
    context: vscode.ExtensionContext,
    map: StoredMap
): Promise<void> {
    const keys = Object.keys(map);
    if (keys.length > LRU_CAP) {
        // Insertion order is preserved by JS objects. We always delete-then-set
        // on update (see `setInstanceOverrides`), so the *last* `LRU_CAP` keys
        // are the most-recently-touched entries. This is more reliable than
        // sorting by `updatedAt`, which can tie at sub-millisecond resolution.
        const trimmed: StoredMap = {};
        for (const key of keys.slice(keys.length - LRU_CAP)) {
            trimmed[key] = map[key];
        }
        await context.globalState.update(STORAGE_KEY, trimmed);
        return;
    }
    await context.globalState.update(STORAGE_KEY, map);
}

export function getInstanceOverrides(
    context: vscode.ExtensionContext,
    uri: vscode.Uri
): PartialPlayerOptions {
    const map = readMap(context);
    const entry = map[uri.toString()];
    return entry ? sanitize(entry.overrides) : {};
}

export async function setInstanceOverrides(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    overrides: PartialPlayerOptions
): Promise<void> {
    const map = readMap(context);
    const clean = sanitize(overrides);
    const key = uri.toString();
    // Always delete-then-set so the entry moves to the end of the iteration
    // order (most-recently-used).
    delete map[key];
    if (Object.keys(clean).length > 0) {
        map[key] = { overrides: clean, updatedAt: Date.now() };
    }
    await writeMap(context, map);
}

export async function clearInstanceOverrides(
    context: vscode.ExtensionContext,
    uri: vscode.Uri
): Promise<void> {
    await setInstanceOverrides(context, uri, {});
}

/**
 * Test-only helper: read the entire stored map (post-sanitize).
 */
export function _readMapForTest(
    context: vscode.ExtensionContext
): StoredMap {
    return readMap(context);
}
