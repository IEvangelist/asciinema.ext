import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectStaticSite } from "../artifact-handlers/detect-static-site.js";

interface FakeExtracted {
    readonly rootDir: { fsPath: string };
    readonly files: string[];
    readonly totalBytes: number;
}

describe("detectStaticSite", () => {
    let tmpRoot: string;

    before(async () => {
        tmpRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "asciinema-detect-")
        );
    });

    after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    async function setupCase(
        name: string,
        files: Record<string, string>
    ): Promise<FakeExtracted> {
        const caseDir = path.join(tmpRoot, name);
        await fs.mkdir(caseDir, { recursive: true });
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(caseDir, ...rel.split("/"));
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, content, "utf8");
        }
        return {
            rootDir: { fsPath: caseDir },
            files: Object.keys(files),
            totalBytes: 0,
        };
    }

    it("returns undefined when no index.html present", async () => {
        const ex = await setupCase("none", {
            "readme.md": "hi",
            "src/app.ts": "//",
        });
        const got = await detectStaticSite(ex as never);
        assert.equal(got, undefined);
    });

    it("detects astro via _astro/ subdirectory", async () => {
        const ex = await setupCase("astro-dir", {
            "dist/index.html": "<html></html>",
            "dist/_astro/main.abc.css": ".x{}",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.isAstro, true);
        assert.match(got!.astroMarkers.join(" "), /_astro/);
    });

    it("detects astro via package.json dependency", async () => {
        const ex = await setupCase("astro-pkg", {
            "package.json": JSON.stringify({
                dependencies: { astro: "^4.5.0" },
            }),
            "dist/index.html": "<html></html>",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.isAstro, true);
        assert.match(got!.astroMarkers.join(" "), /astro@\^4\.5\.0/);
    });

    it("detects astro via generator meta tag", async () => {
        const ex = await setupCase("astro-meta", {
            "out/index.html":
                '<html><head><meta name="generator" content="Astro v4.5.0"></head></html>',
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.isAstro, true);
        assert.match(got!.astroMarkers.join(" "), /generator/);
    });

    it("returns non-astro detection for plain static site", async () => {
        const ex = await setupCase("plain", {
            "site/index.html": "<html><body>hello</body></html>",
            "site/style.css": "body{}",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.isAstro, false);
        assert.equal(got!.astroMarkers.length, 0);
        assert.equal(path.basename(got!.siteRoot), "site");
    });

    it("prefers shallowest index.html when multiple exist", async () => {
        const ex = await setupCase("nested", {
            "dist/index.html": "<html></html>",
            "dist/sub/page/index.html": "<html></html>",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.indexRelPath, "dist/index.html");
    });
});
