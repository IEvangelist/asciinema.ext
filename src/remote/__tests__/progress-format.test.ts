import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    buildProgressMessage,
    estimateEtaMs,
    formatDuration,
    formatRate,
} from "../progress-format.js";

describe("formatDuration", () => {
    it("returns 0s for non-finite or negative", () => {
        assert.equal(formatDuration(NaN), "0s");
        assert.equal(formatDuration(-1), "0s");
    });
    it("renders sub-second as <1s", () => {
        assert.equal(formatDuration(0), "<1s");
        assert.equal(formatDuration(999), "<1s");
    });
    it("renders seconds", () => {
        assert.equal(formatDuration(1_000), "1s");
        assert.equal(formatDuration(45_000), "45s");
    });
    it("renders minutes + seconds", () => {
        assert.equal(formatDuration(65_000), "1m 5s");
        assert.equal(formatDuration(3_540_000), "59m 0s");
    });
    it("renders hours + minutes when >=1h", () => {
        assert.equal(formatDuration(3_600_000), "1h 0m");
        assert.equal(formatDuration(3_725_000), "1h 2m");
    });
});

describe("formatRate", () => {
    it("returns empty for zero / negative / non-finite", () => {
        assert.equal(formatRate(0), "");
        assert.equal(formatRate(-1), "");
        assert.equal(formatRate(NaN), "");
    });
    it("formats positive rates", () => {
        assert.equal(formatRate(5 * 1024 * 1024), "5.0 MB/s");
        assert.equal(formatRate(2048), "2.0 KB/s");
    });
});

describe("estimateEtaMs", () => {
    it("returns undefined for invalid inputs", () => {
        assert.equal(estimateEtaMs(0, 0.5), undefined);
        assert.equal(estimateEtaMs(1000, 0), undefined);
        assert.equal(estimateEtaMs(1000, 1), undefined);
        assert.equal(estimateEtaMs(1000, NaN), undefined);
    });
    it("computes remaining ms from elapsed and fraction", () => {
        // 5s elapsed at 50% → ~5s remaining
        assert.equal(estimateEtaMs(5_000, 0.5), 5_000);
        // 3s elapsed at 25% → ~9s remaining
        assert.equal(estimateEtaMs(3_000, 0.25), 9_000);
    });
});

describe("buildProgressMessage", () => {
    it("renders bytes-of-bytes with rate, eta, and quip on three lines", () => {
        const msg = buildProgressMessage({
            received: 458 * 1024 * 1024,
            total: 695 * 1024 * 1024,
            elapsedMs: 38_000,
            quip: "🥖 You could've baked bread by now.",
        });
        const lines = msg.split("\n");
        assert.equal(lines.length, 3);
        assert.match(lines[0], /458\.0 MB of 695\.0 MB · 65% · [\d.]+ MB\/s/);
        assert.match(lines[1], /Elapsed 38s · ~\d+s remaining/);
        assert.equal(lines[2], "🥖 You could've baked bread by now.");
    });

    it("omits ETA line element when total is unknown", () => {
        const msg = buildProgressMessage({
            received: 1024 * 1024,
            elapsedMs: 2_000,
        });
        const lines = msg.split("\n");
        assert.equal(lines.length, 2);
        assert.match(lines[0], /1\.0 MB downloaded/);
        assert.equal(lines[1], "Elapsed 2s");
    });

    it("uses files-of-files headline for extraction phase", () => {
        const msg = buildProgressMessage({
            received: 245 * 1024 * 1024,
            elapsedMs: 14_000,
            files: { written: 12_403, total: 27_718 },
            quip: "🗜️ Squeezing the last bytes…",
        });
        const lines = msg.split("\n");
        assert.equal(lines.length, 3);
        assert.match(
            lines[0],
            /12,403 of 27,718 files · 245\.0 MB · 44%/
        );
        assert.match(lines[1], /Elapsed 14s · ~\d+s remaining · [\d.]+ MB\/s/);
        assert.equal(lines[2], "🗜️ Squeezing the last bytes…");
    });

    it("omits quip line when not provided", () => {
        const msg = buildProgressMessage({
            received: 100,
            total: 1000,
            elapsedMs: 1_000,
        });
        const lines = msg.split("\n");
        assert.equal(lines.length, 2);
    });
});
