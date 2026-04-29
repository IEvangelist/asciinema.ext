import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { safeJoinRelative } from "../safe-path.js";

describe("safeJoinRelative", () => {
    const dest = path.resolve("/tmp/dest");
    it("accepts plain relative paths", () => {
        assert.equal(safeJoinRelative(dest, "a/b.txt"), path.join("a", "b.txt"));
        assert.equal(safeJoinRelative(dest, "dist/index.html"), path.join("dist", "index.html"));
    });
    it("strips leading slashes", () => {
        assert.equal(safeJoinRelative(dest, "/a/b.txt"), path.join("a", "b.txt"));
    });
    it("normalizes backslashes", () => {
        assert.equal(safeJoinRelative(dest, "a\\b.txt"), path.join("a", "b.txt"));
    });
    it("rejects empty paths", () => {
        assert.equal(safeJoinRelative(dest, ""), undefined);
        assert.equal(safeJoinRelative(dest, "/"), undefined);
    });
    it("rejects traversal segments", () => {
        assert.equal(safeJoinRelative(dest, "../etc"), undefined);
        assert.equal(safeJoinRelative(dest, "a/../../etc"), undefined);
        assert.equal(safeJoinRelative(dest, "./../../etc"), undefined);
    });
    it("rejects absolute Windows paths", () => {
        assert.equal(safeJoinRelative(dest, "C:/Windows/system32"), undefined);
    });
    it("rejects entries containing NUL bytes", () => {
        assert.equal(safeJoinRelative(dest, "a\0b.txt"), undefined);
        assert.equal(safeJoinRelative(dest, "\0"), undefined);
    });
});
