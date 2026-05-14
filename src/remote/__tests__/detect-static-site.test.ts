import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectStaticSite } from "../artifact-handlers/detect-static-site.js";

describe("detectStaticSite", () => {
    it("returns undefined when no index.html present", () => {
        const got = detectStaticSite({
            files: ["readme.md", "src/app.ts"],
        });
        assert.equal(got, undefined);
    });

    it("detects an index.html at the artifact root", () => {
        const got = detectStaticSite({
            files: ["index.html", "style.css"],
        });
        assert.ok(got);
        assert.equal(got!.indexRelPath, "index.html");
        assert.equal(got!.siteRel, ".");
        assert.equal(got!.fileCount, 2);
    });

    it("detects nested static sites", () => {
        const got = detectStaticSite({
            files: ["site/index.html", "site/style.css"],
        });
        assert.ok(got);
        assert.equal(got!.indexRelPath, "site/index.html");
        assert.equal(got!.siteRel, "site");
        assert.equal(got!.fileCount, 2);
    });

    it("prefers shallowest index.html when multiple exist", () => {
        const got = detectStaticSite({
            files: ["dist/index.html", "dist/sub/page/index.html"],
        });
        assert.ok(got);
        assert.equal(got!.indexRelPath, "dist/index.html");
        assert.equal(got!.siteRel, "dist");
    });

    it("is case-insensitive when matching index.html", () => {
        const got = detectStaticSite({
            files: ["dist/Index.HTML"],
        });
        assert.ok(got);
        assert.equal(got!.indexRelPath, "dist/Index.HTML");
        assert.equal(got!.siteRel, "dist");
    });

    it("counts only files under the resolved site root", () => {
        const got = detectStaticSite({
            files: [
                "dist/index.html",
                "dist/app.js",
                "dist/assets/x.png",
                "logs/build.log",
            ],
        });
        assert.ok(got);
        assert.equal(got!.siteRel, "dist");
        assert.equal(got!.fileCount, 3);
    });
});
