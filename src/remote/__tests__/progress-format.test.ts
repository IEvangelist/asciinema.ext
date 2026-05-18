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
    it("renders bytes/total/pct/speed/elapsed/eta/quip as one line separated by ` · `", () => {
        const msg = buildProgressMessage({
            received: 458 * 1024 * 1024,
            total: 695 * 1024 * 1024,
            elapsedMs: 38_000,
            quip: "🥖 You could've baked bread by now.",
        });
        const parts = msg.split(" · ");
        assert.equal(parts.length, 6);
        assert.match(parts[0], /^📥 458\.0 MB of 695\.0 MB$/);
        assert.match(parts[1], /^📊 65%$/);
        assert.match(parts[2], /^⚡ [\d.]+ MB\/s$/);
        assert.match(parts[3], /^⏱ 38s elapsed$/);
        assert.match(parts[4], /^⏳ ~\d+s remaining$/);
        assert.equal(parts[5], "🥖 You could've baked bread by now.");
        // Sanity: no leftover $(codicon) tokens or `\n` line breaks slipped through.
        assert.ok(!/\$\(/.test(msg), `unexpected codicon token in: ${msg}`);
        assert.ok(!msg.includes("\n"), `unexpected newline in: ${msg}`);
    });

    it("omits the eta segment when total is unknown", () => {
        const msg = buildProgressMessage({
            received: 1024 * 1024,
            elapsedMs: 2_000,
        });
        const parts = msg.split(" · ");
        // size + speed + elapsed (no %, no eta, no quip)
        assert.equal(parts.length, 3);
        assert.match(parts[0], /^📥 1\.0 MB downloaded$/);
        assert.match(parts[1], /^⚡ [\d.]+ KB\/s|^⚡ [\d.]+ MB\/s/);
        assert.match(parts[2], /^⏱ 2s elapsed$/);
    });

    it("uses files-of-files headline for extraction phase", () => {
        const msg = buildProgressMessage({
            received: 245 * 1024 * 1024,
            elapsedMs: 14_000,
            files: { written: 12_403, total: 27_718 },
            quip: "🗜️ Squeezing the last bytes…",
        });
        const parts = msg.split(" · ");
        assert.equal(parts.length, 6);
        assert.match(
            parts[0],
            /^🗜 12,403 of 27,718 files \(245\.0 MB\)$/
        );
        assert.match(parts[1], /^📊 44%$/);
        assert.match(parts[2], /^⚡ [\d.]+ MB\/s$/);
        assert.match(parts[3], /^⏱ 14s elapsed$/);
        assert.match(parts[4], /^⏳ ~\d+s remaining$/);
        assert.equal(parts[5], "🗜️ Squeezing the last bytes…");
    });

    it("omits quip segment when not provided", () => {
        const msg = buildProgressMessage({
            received: 100,
            total: 1000,
            elapsedMs: 1_000,
        });
        const parts = msg.split(" · ");
        // size + % + speed + elapsed + eta (no quip) = 5 segments.
        // 100B in 1s = 100 B/s, formatBytesShort emits "100 B/s" → non-empty → speed segment present.
        // At 10% elapsed 1s → eta=9s → eta segment present.
        assert.equal(parts.length, 5);
        assert.ok(!parts.some((p) => p.includes("🥖")));
    });
});
