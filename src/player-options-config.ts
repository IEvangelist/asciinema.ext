/**
 * VS Code-bound layer for player options: reads/writes user-global settings
 * for `asciinema.player.*` keys. Kept separate from `./player-options.ts`
 * so the pure logic remains unit-testable without the extension host.
 */
import * as vscode from "vscode";
import {
    coerceOption,
    DEFAULT_PLAYER_OPTIONS,
    PLAYER_OPTION_KEYS,
    type PartialPlayerOptions,
} from "./player-options.js";

const SECTION = "asciinema.player";

/**
 * Returns the user's global config values from VS Code settings. Only
 * sets keys that the user has actually configured (so the layered merge
 * resolves to defaults when nothing is set).
 */
export function readGlobalOptions(): PartialPlayerOptions {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const out: PartialPlayerOptions = {};
    for (const key of PLAYER_OPTION_KEYS) {
        const inspect = cfg.inspect(key);
        const value =
            inspect?.globalValue ??
            inspect?.workspaceValue ??
            inspect?.workspaceFolderValue;
        if (value === undefined) {
            continue;
        }
        const coerced = coerceOption(key, value);
        if (coerced !== undefined || (key === "idleTimeLimit" && value === null)) {
            (out as Record<string, unknown>)[key] = coerced;
        }
    }
    return out;
}

/**
 * Writes a per-key patch into the user's *global* settings. Keys whose
 * value matches the schema default (i.e. equal to `DEFAULT_PLAYER_OPTIONS`)
 * are *removed* so the resolved value falls through to the baked-in default.
 */
export async function writeGlobalOptions(
    patch: PartialPlayerOptions
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    for (const key of PLAYER_OPTION_KEYS) {
        if (!(key in patch)) {
            continue;
        }
        const value = patch[key];
        const isDefault =
            JSON.stringify(value) ===
            JSON.stringify(DEFAULT_PLAYER_OPTIONS[key]);
        await cfg.update(
            key,
            isDefault ? undefined : value,
            vscode.ConfigurationTarget.Global
        );
    }
}

export function isPlayerConfigChange(
    e: vscode.ConfigurationChangeEvent
): boolean {
    return e.affectsConfiguration(SECTION);
}
