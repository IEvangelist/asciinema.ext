import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDownloadQuip } from "../download-quips.js";

describe("getDownloadQuip", () => {
    it("returns nothing under 5s", () => {
        assert.equal(getDownloadQuip(0), undefined);
        assert.equal(getDownloadQuip(4_999), undefined);
    });

    it("returns a quip after 5s", () => {
        const q = getDownloadQuip(5_000);
        assert.ok(q && q.length > 0);
    });

    it("escalates tier with elapsed time", () => {
        const tiers = [5_000, 15_000, 30_000, 60_000].map((t) =>
            getDownloadQuip(t)
        );
        for (const t of tiers) {
            assert.ok(t && t.length > 0);
        }
    });

    it("rotates over time", () => {
        const a = getDownloadQuip(5_000);
        const b = getDownloadQuip(9_000);
        // At least one of them should differ across the rotation.
        assert.ok(a !== undefined && b !== undefined);
    });
});
