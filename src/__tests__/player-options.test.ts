import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    coerceOption,
    DEFAULT_PLAYER_OPTIONS,
    isPartialPlayerOptions,
    mergeOptions,
    sanitize,
    toPlayerCreateOptions,
} from "../player-options.js";

describe("coerceOption", () => {
    it("accepts valid booleans for boolean keys", () => {
        assert.equal(coerceOption("autoPlay", true), true);
        assert.equal(coerceOption("autoPlay", false), false);
        assert.equal(coerceOption("preload", true), true);
        assert.equal(coerceOption("pauseOnMarkers", false), false);
    });
    it("rejects non-booleans for boolean keys", () => {
        assert.equal(coerceOption("autoPlay", "true"), undefined);
        assert.equal(coerceOption("preload", 1), undefined);
    });
    it("loop accepts boolean and non-negative numbers", () => {
        assert.equal(coerceOption("loop", true), true);
        assert.equal(coerceOption("loop", false), false);
        assert.equal(coerceOption("loop", 3), 3);
        assert.equal(coerceOption("loop", -1), undefined);
        assert.equal(coerceOption("loop", "yes"), undefined);
    });
    it("startAt accepts numbers and m:ss / h:mm:ss strings", () => {
        assert.equal(coerceOption("startAt", 0), 0);
        assert.equal(coerceOption("startAt", 12.5), 12.5);
        assert.equal(coerceOption("startAt", "2:03"), "2:03");
        assert.equal(coerceOption("startAt", "1:02:03"), "1:02:03");
        assert.equal(coerceOption("startAt", ""), 0);
        assert.equal(coerceOption("startAt", "abc"), undefined);
        assert.equal(coerceOption("startAt", -1), undefined);
    });
    it("speed only accepts positive numbers", () => {
        assert.equal(coerceOption("speed", 2), 2);
        assert.equal(coerceOption("speed", 0.5), 0.5);
        assert.equal(coerceOption("speed", 0), undefined);
        assert.equal(coerceOption("speed", -1), undefined);
        assert.equal(coerceOption("speed", "fast"), undefined);
    });
    it("idleTimeLimit accepts null or non-negative numbers", () => {
        assert.equal(coerceOption("idleTimeLimit", null), null);
        assert.equal(coerceOption("idleTimeLimit", 0), 0);
        assert.equal(coerceOption("idleTimeLimit", 2), 2);
        assert.equal(coerceOption("idleTimeLimit", -1), undefined);
        assert.equal(coerceOption("idleTimeLimit", "2"), undefined);
    });
    it("fit only accepts the four supported values", () => {
        for (const v of ["width", "height", "both", "none"]) {
            assert.equal(coerceOption("fit", v), v);
        }
        assert.equal(coerceOption("fit", "auto"), undefined);
    });
    it("controls accepts auto/always/never", () => {
        assert.equal(coerceOption("controls", "auto"), "auto");
        assert.equal(coerceOption("controls", "always"), "always");
        assert.equal(coerceOption("controls", "never"), "never");
        assert.equal(coerceOption("controls", true), undefined);
    });
    it("terminalLineHeight requires a positive number", () => {
        assert.equal(coerceOption("terminalLineHeight", 1.5), 1.5);
        assert.equal(coerceOption("terminalLineHeight", 0), undefined);
        assert.equal(coerceOption("terminalLineHeight", -1), undefined);
    });
    it("string keys reject non-strings", () => {
        assert.equal(coerceOption("theme", 1), undefined);
        assert.equal(coerceOption("terminalFontFamily", null), undefined);
        assert.equal(
            coerceOption("poster", "data:text/plain,hi"),
            "data:text/plain,hi"
        );
    });
});

describe("sanitize", () => {
    it("drops unknown keys", () => {
        const out = sanitize({ autoPlay: true, foo: "bar", evil: 1 });
        assert.deepEqual(out, { autoPlay: true });
    });
    it("drops keys with invalid values", () => {
        const out = sanitize({ speed: -1, autoPlay: true });
        assert.deepEqual(out, { autoPlay: true });
    });
    it("preserves null for idleTimeLimit", () => {
        const out = sanitize({ idleTimeLimit: null });
        assert.deepEqual(out, { idleTimeLimit: null });
    });
    it("returns empty object for non-objects", () => {
        assert.deepEqual(sanitize(null), {});
        assert.deepEqual(sanitize(undefined), {});
        assert.deepEqual(sanitize(42), {});
    });
});

describe("isPartialPlayerOptions", () => {
    it("accepts objects with only known keys", () => {
        assert.equal(isPartialPlayerOptions({ autoPlay: true }), true);
        assert.equal(isPartialPlayerOptions({}), true);
    });
    it("rejects objects with unknown keys", () => {
        assert.equal(isPartialPlayerOptions({ autoPlay: true, foo: 1 }), false);
    });
    it("rejects non-objects", () => {
        assert.equal(isPartialPlayerOptions(null), false);
        assert.equal(isPartialPlayerOptions("string"), false);
    });
});

describe("mergeOptions", () => {
    it("falls through to defaults when nothing is set", () => {
        const r = mergeOptions({}, {});
        assert.deepEqual(r.merged, DEFAULT_PLAYER_OPTIONS);
        for (const key of Object.keys(r.source)) {
            assert.equal(r.source[key as keyof typeof r.source], "default");
        }
    });
    it("instance overrides global overrides default", () => {
        const r = mergeOptions(
            { speed: 2, autoPlay: false },
            { speed: 4 }
        );
        assert.equal(r.merged.speed, 4);
        assert.equal(r.source.speed, "instance");
        assert.equal(r.merged.autoPlay, false);
        assert.equal(r.source.autoPlay, "global");
        assert.equal(r.merged.theme, DEFAULT_PLAYER_OPTIONS.theme);
        assert.equal(r.source.theme, "default");
    });
    it("ignores invalid override values without affecting valid ones", () => {
        const r = mergeOptions(
            { speed: -1 as unknown as number, autoPlay: false },
            {}
        );
        assert.equal(r.merged.speed, DEFAULT_PLAYER_OPTIONS.speed);
        assert.equal(r.source.speed, "default");
        assert.equal(r.merged.autoPlay, false);
        assert.equal(r.source.autoPlay, "global");
    });
    it("idleTimeLimit:null in instance overrides a global numeric", () => {
        const r = mergeOptions({ idleTimeLimit: 2 }, { idleTimeLimit: null });
        assert.equal(r.merged.idleTimeLimit, null);
        assert.equal(r.source.idleTimeLimit, "instance");
    });
});

describe("toPlayerCreateOptions", () => {
    it("omits poster when blank", () => {
        const out = toPlayerCreateOptions(DEFAULT_PLAYER_OPTIONS);
        assert.equal("poster" in out, false);
    });
    it("omits theme when 'auto'", () => {
        const out = toPlayerCreateOptions(DEFAULT_PLAYER_OPTIONS);
        assert.equal("theme" in out, false);
    });
    it("includes theme when not 'auto'", () => {
        const out = toPlayerCreateOptions({
            ...DEFAULT_PLAYER_OPTIONS,
            theme: "dracula",
        });
        assert.equal(out.theme, "dracula");
    });
    it("translates fit:'none' to false", () => {
        const out = toPlayerCreateOptions({
            ...DEFAULT_PLAYER_OPTIONS,
            fit: "none",
        });
        assert.equal(out.fit, false);
    });
    it("translates controls strings to bool/'auto'", () => {
        const a = toPlayerCreateOptions({
            ...DEFAULT_PLAYER_OPTIONS,
            controls: "always",
        });
        assert.equal(a.controls, true);
        const n = toPlayerCreateOptions({
            ...DEFAULT_PLAYER_OPTIONS,
            controls: "never",
        });
        assert.equal(n.controls, false);
        const auto = toPlayerCreateOptions({
            ...DEFAULT_PLAYER_OPTIONS,
            controls: "auto",
        });
        assert.equal(auto.controls, "auto");
    });
    it("omits idleTimeLimit when null, includes when set", () => {
        const a = toPlayerCreateOptions(DEFAULT_PLAYER_OPTIONS);
        assert.equal("idleTimeLimit" in a, false);
        const b = toPlayerCreateOptions({
            ...DEFAULT_PLAYER_OPTIONS,
            idleTimeLimit: 2,
        });
        assert.equal(b.idleTimeLimit, 2);
    });
    it("includes rows override when given", () => {
        const out = toPlayerCreateOptions(DEFAULT_PLAYER_OPTIONS, { rows: 12 });
        assert.equal(out.rows, 12);
    });
});
