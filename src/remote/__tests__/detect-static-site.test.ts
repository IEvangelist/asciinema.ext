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

    it("detects an index.html at the artifact root", async () => {
        const ex = await setupCase("root", {
            "index.html": "<html></html>",
            "style.css": "body{}",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.indexRelPath, "index.html");
        assert.equal(got!.siteRoot, ex.rootDir.fsPath);
        assert.equal(got!.fileCount, 2);
    });

    it("detects nested static sites", async () => {
        const ex = await setupCase("nested", {
            "site/index.html": "<html><body>hello</body></html>",
            "site/style.css": "body{}",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.indexRelPath, "site/index.html");
        assert.equal(path.basename(got!.siteRoot), "site");
        assert.equal(got!.fileCount, 2);
    });

    it("prefers shallowest index.html when multiple exist", async () => {
        const ex = await setupCase("multi", {
            "dist/index.html": "<html></html>",
            "dist/sub/page/index.html": "<html></html>",
        });
        const got = await detectStaticSite(ex as never);
        assert.ok(got);
        assert.equal(got!.indexRelPath, "dist/index.html");
    });
});
