import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatBytes,
    formatDateRange,
} from "../cache-format.js";

describe("formatBytes", () => {
    it("formats zero / negative / NaN as '0 B'", () => {
        assert.equal(formatBytes(0), "0 B");
        assert.equal(formatBytes(-1), "0 B");
        assert.equal(formatBytes(Number.NaN), "0 B");
    });

    it("formats raw bytes without a decimal", () => {
        assert.equal(formatBytes(512), "512 B");
        assert.equal(formatBytes(1023), "1023 B");
    });

    it("formats KB with at most two decimals", () => {
        assert.equal(formatBytes(1024), "1.00 KB");
        assert.equal(formatBytes(1536), "1.50 KB");
        assert.equal(formatBytes(20 * 1024), "20.0 KB");
        assert.equal(formatBytes(500 * 1024), "500 KB");
    });

    it("formats MB / GB / TB", () => {
        assert.equal(formatBytes(2 * 1024 * 1024), "2.00 MB");
        assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
        assert.equal(formatBytes(2.5 * 1024 ** 4), "2.50 TB");
    });
});

describe("formatDateRange", () => {
    it("returns empty for non-finite inputs", () => {
        assert.equal(formatDateRange(Number.NaN, 0), "");
        assert.equal(formatDateRange(0, Number.POSITIVE_INFINITY), "");
    });

    it("returns a single date when min == max", () => {
        const t = Date.UTC(2026, 0, 15);
        const out = formatDateRange(t, t);
        // Avoid locale-specific format assertions — assert structure.
        assert.ok(typeof out === "string" && out.length > 0);
        assert.ok(!out.includes("–"));
    });

    it("joins min and max with an en-dash when they differ", () => {
        const a = Date.UTC(2026, 0, 5);
        const b = Date.UTC(2026, 4, 14);
        const out = formatDateRange(a, b);
        assert.ok(out.includes(" – "));
    });
});
