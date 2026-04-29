/**
 * Asciinema player options exposed in the settings cog.
 *
 * Three-tier resolution: defaults <- global (VS Code config `asciinema.player.*`)
 * <- per-instance (globalState map keyed by cast URI). Final values flow into
 * `AsciinemaPlayer.create(...)` in the webview.
 *
 * This module is intentionally **vscode-free** so it can be unit-tested
 * outside the extension host. The vscode-dependent layer lives in
 * `./player-options-config.ts`.
 *
 * See https://docs.asciinema.org/manual/player/options/ for the source of
 * truth on each option's semantics.
 */
export type LoopValue = boolean | number;
export type FitValue = "width" | "height" | "both" | "none";
export type ControlsValue = "auto" | "always" | "never";
export type FontSizeValue = "small" | "medium" | "big" | string; // CSS size

export interface PlayerOptions {
    autoPlay: boolean;
    preload: boolean;
    loop: LoopValue;
    startAt: number | string;
    speed: number;
    idleTimeLimit: number | null;
    pauseOnMarkers: boolean;
    theme: string;
    fit: FitValue;
    controls: ControlsValue;
    terminalFontSize: FontSizeValue;
    terminalFontFamily: string;
    terminalLineHeight: number;
    poster: string;
}

export type PartialPlayerOptions = Partial<PlayerOptions>;

/** Baked-in defaults — the bottom layer of the three-tier resolution. */
export const DEFAULT_PLAYER_OPTIONS: PlayerOptions = {
    autoPlay: true,
    preload: false,
    loop: false,
    startAt: 0,
    speed: 1,
    idleTimeLimit: null,
    pauseOnMarkers: false,
    theme: "auto",
    fit: "width",
    controls: "auto",
    terminalFontSize: "small",
    terminalFontFamily:
        "'Cascadia Code', 'Fira Code', 'Menlo', 'Monaco', 'Courier New', monospace",
    terminalLineHeight: 1.33333333,
    poster: "",
};

/** All keys of {@link PlayerOptions} as a readonly tuple, derived from the defaults. */
export const PLAYER_OPTION_KEYS = Object.keys(
    DEFAULT_PLAYER_OPTIONS
) as readonly (keyof PlayerOptions)[];

/**
 * Theme identifiers accepted by the asciinema player. `"auto"` is our own
 * convention meaning "follow VS Code's theme".
 */
export const THEME_CHOICES = [
    "auto",
    "asciinema",
    "dracula",
    "monokai",
    "nord",
    "solarized-dark",
    "solarized-light",
    "tango",
] as const;

const FIT_CHOICES: readonly FitValue[] = ["width", "height", "both", "none"];
const CONTROLS_CHOICES: readonly ControlsValue[] = [
    "auto",
    "always",
    "never",
];
const FONT_SIZE_PRESETS = ["small", "medium", "big"] as const;

/**
 * Returns true if every key in `patch` is a recognized PlayerOptions key.
 */
export function isPartialPlayerOptions(
    value: unknown
): value is PartialPlayerOptions {
    if (!value || typeof value !== "object") {
        return false;
    }
    const known = new Set<string>(PLAYER_OPTION_KEYS);
    for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!known.has(key)) {
            return false;
        }
    }
    return true;
}

/**
 * Coerces & validates a single option to its expected shape, or returns
 * `undefined` if the value is unusable. Used when ingesting values from
 * VS Code config (loose JSON) and from per-instance overrides.
 */
export function coerceOption<K extends keyof PlayerOptions>(
    key: K,
    value: unknown
): PlayerOptions[K] | undefined {
    if (value === undefined) {
        return undefined;
    }
    switch (key) {
        case "autoPlay":
        case "preload":
        case "pauseOnMarkers":
            return (typeof value === "boolean"
                ? value
                : undefined) as PlayerOptions[K] | undefined;
        case "loop":
            if (typeof value === "boolean") {
                return value as PlayerOptions[K];
            }
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
                return value as PlayerOptions[K];
            }
            return undefined;
        case "startAt":
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
                return value as PlayerOptions[K];
            }
            if (typeof value === "string" && /^\d+(:\d{1,2}){0,2}$/.test(value)) {
                return value as PlayerOptions[K];
            }
            if (typeof value === "string" && value === "") {
                return 0 as PlayerOptions[K];
            }
            return undefined;
        case "speed":
            if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
                return value as PlayerOptions[K];
            }
            return undefined;
        case "idleTimeLimit":
            if (value === null) {
                return null as PlayerOptions[K];
            }
            if (typeof value === "number" && value >= 0 && Number.isFinite(value)) {
                return value as PlayerOptions[K];
            }
            return undefined;
        case "theme":
            return typeof value === "string" && value.length > 0
                ? (value as PlayerOptions[K])
                : undefined;
        case "fit":
            return FIT_CHOICES.includes(value as FitValue)
                ? (value as PlayerOptions[K])
                : undefined;
        case "controls":
            return CONTROLS_CHOICES.includes(value as ControlsValue)
                ? (value as PlayerOptions[K])
                : undefined;
        case "terminalFontSize":
            if (typeof value !== "string" || value.length === 0) {
                return undefined;
            }
            return value as PlayerOptions[K];
        case "terminalFontFamily":
            return typeof value === "string"
                ? (value as PlayerOptions[K])
                : undefined;
        case "terminalLineHeight":
            if (
                typeof value === "number" &&
                Number.isFinite(value) &&
                value > 0
            ) {
                return value as PlayerOptions[K];
            }
            return undefined;
        case "poster":
            return typeof value === "string"
                ? (value as PlayerOptions[K])
                : undefined;
        default:
            return undefined;
    }
}

/**
 * Filters an unknown object down to a typed `PartialPlayerOptions`,
 * dropping unknown keys and silently rejecting bad values. Used at the
 * boundary with VS Code config + persisted instance overrides.
 */
export function sanitize(input: unknown): PartialPlayerOptions {
    if (!input || typeof input !== "object") {
        return {};
    }
    const out: PartialPlayerOptions = {};
    const obj = input as Record<string, unknown>;
    for (const key of PLAYER_OPTION_KEYS) {
        if (!(key in obj)) {
            continue;
        }
        const coerced = coerceOption(key, obj[key]);
        if (coerced !== undefined || (key === "idleTimeLimit" && obj[key] === null)) {
            // idleTimeLimit specifically allows `null` as a valid coerced value
            (out as Record<string, unknown>)[key] = coerced;
        }
    }
    return out;
}

export interface MergedResolution {
    readonly merged: PlayerOptions;
    readonly defaults: PlayerOptions;
    readonly global: PartialPlayerOptions;
    readonly instance: PartialPlayerOptions;
    /** For each option, which layer "wins" — useful for UI badges. */
    readonly source: Record<keyof PlayerOptions, "default" | "global" | "instance">;
}

/**
 * Resolves the three layers into a single options object. Per-instance
 * wins over global wins over baked-in default.
 */
export function mergeOptions(
    global: PartialPlayerOptions,
    instance: PartialPlayerOptions
): MergedResolution {
    const merged = { ...DEFAULT_PLAYER_OPTIONS } as PlayerOptions;
    const source = {} as Record<keyof PlayerOptions, "default" | "global" | "instance">;
    const cleanGlobal = sanitize(global);
    const cleanInstance = sanitize(instance);
    for (const key of PLAYER_OPTION_KEYS) {
        if (key in cleanInstance) {
            (merged as unknown as Record<string, unknown>)[key] =
                cleanInstance[key];
            source[key] = "instance";
        } else if (key in cleanGlobal) {
            (merged as unknown as Record<string, unknown>)[key] =
                cleanGlobal[key];
            source[key] = "global";
        } else {
            source[key] = "default";
        }
    }
    return {
        merged,
        defaults: { ...DEFAULT_PLAYER_OPTIONS },
        global: cleanGlobal,
        instance: cleanInstance,
        source,
    };
}

/**
 * Maps merged player options into the literal object passed to
 * `AsciinemaPlayer.create(...)`. Values that should fall back to the
 * player's own defaults (e.g. an unset poster, idleTimeLimit) are omitted.
 */
export function toPlayerCreateOptions(
    o: PlayerOptions,
    overrides: { rows?: number } = {}
): Record<string, unknown> {
    const out: Record<string, unknown> = {
        autoPlay: o.autoPlay,
        preload: o.preload,
        loop: o.loop,
        startAt: o.startAt === 0 ? 0 : o.startAt,
        speed: o.speed,
        pauseOnMarkers: o.pauseOnMarkers,
        terminalFontFamily: o.terminalFontFamily,
        terminalLineHeight: o.terminalLineHeight,
        logger: undefined,
    };
    if (o.idleTimeLimit !== null) {
        out.idleTimeLimit = o.idleTimeLimit;
    }
    if (o.fit === "none") {
        out.fit = false;
    } else {
        out.fit = o.fit;
    }
    switch (o.controls) {
        case "always":
            out.controls = true;
            break;
        case "never":
            out.controls = false;
            break;
        default:
            out.controls = "auto";
    }
    if (FONT_SIZE_PRESETS.includes(o.terminalFontSize as never)) {
        out.terminalFontSize = o.terminalFontSize;
    } else if (o.terminalFontSize) {
        out.terminalFontSize = o.terminalFontSize;
    }
    if (o.poster && o.poster.length > 0) {
        out.poster = o.poster;
    }
    if (o.theme && o.theme !== "auto") {
        out.theme = o.theme;
    }
    if (overrides.rows !== undefined) {
        out.rows = overrides.rows;
    }
    delete out.logger;
    return out;
}
