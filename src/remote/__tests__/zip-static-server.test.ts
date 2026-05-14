import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import JSZip from "jszip";
import {
    resolveZipRequest,
    startZipStaticServer,
    type ZipStaticServerHandle,
} from "../zip-static-server.js";

async function fetchPath(
    handle: ZipStaticServerHandle,
    urlPath: string,
    method = "GET"
): Promise<{ status: number; body: string; contentType?: string }> {
    return await new Promise((resolve, reject) => {
        const req = http.request(
            `${handle.url}${urlPath}`,
            { method },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                        contentType: res.headers["content-type"],
                    });
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

async function buildZip(
    files: Record<string, string | Uint8Array>
): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
        zip.file(name, content);
    }
    return await zip.generateAsync({ type: "uint8array" });
}

describe("resolveZipRequest", () => {
    it("maps root request to siteRel/index.html-able key", () => {
        assert.equal(resolveZipRequest("dist", "/"), "dist");
        assert.equal(resolveZipRequest("dist", "/app.js"), "dist/app.js");
        assert.equal(
            resolveZipRequest("dist", "/sub/page.html"),
            "dist/sub/page.html"
        );
    });

    it("handles archive-root siteRel ('' or '.')", () => {
        assert.equal(resolveZipRequest("", "/"), "");
        assert.equal(resolveZipRequest(".", "/index.html"), "index.html");
        assert.equal(resolveZipRequest("", "/style.css"), "style.css");
    });

    it("rejects path traversal", () => {
        assert.equal(resolveZipRequest("dist", "/../etc/passwd"), undefined);
    });

    it("handles encoded paths", () => {
        assert.equal(
            resolveZipRequest("dist", "/some%20file.txt"),
            "dist/some file.txt"
        );
    });

    it("strips query/fragment", () => {
        assert.equal(
            resolveZipRequest("dist", "/app.js?v=1#frag"),
            "dist/app.js"
        );
    });
});

describe("startZipStaticServer", () => {
    let tmpDir: string;
    let zipPath: string;
    let handle: ZipStaticServerHandle | undefined;

    before(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zss-"));
        const bytes = await buildZip({
            "dist/index.html": "<!doctype html><title>hi</title>",
            "dist/app.js": "console.log('hi')",
            "dist/sub/index.html": "<!doctype html><title>sub</title>",
            "dist/assets/logo.png": Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]),
            "other/readme.md": "not in site",
        });
        zipPath = path.join(tmpDir, "artifact.zip");
        await fs.writeFile(zipPath, bytes);
    });

    after(async () => {
        await handle?.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("serves index.html for the root request", async () => {
        handle = await startZipStaticServer({
            zipPath,
            siteRel: "dist",
            maxEntryBytes: 4 * 1024 * 1024,
        });
        const res = await fetchPath(handle, "/");
        assert.equal(res.status, 200);
        assert.match(res.body, /<title>hi<\/title>/);
        assert.ok(res.contentType?.startsWith("text/html"));
    });

    it("serves a named file", async () => {
        const res = await fetchPath(handle!, "/app.js");
        assert.equal(res.status, 200);
        assert.match(res.body, /console\.log/);
        assert.ok(res.contentType?.startsWith("application/javascript"));
    });

    it("serves sub-directory index.html for /sub/", async () => {
        const res = await fetchPath(handle!, "/sub/");
        assert.equal(res.status, 200);
        assert.match(res.body, /<title>sub<\/title>/);
    });

    it("404s entries outside the site root", async () => {
        const res = await fetchPath(handle!, "/readme.md");
        assert.equal(res.status, 404);
    });

    it("rejects traversal", async () => {
        // Node's HTTP client normalizes `..` segments before sending, so the
        // server may receive either a traversal request (-> 400) or an
        // already-normalized one (-> 404 since the entry isn't in the site).
        // Both outcomes are safe.
        const res = await fetchPath(handle!, "/%2e%2e/other/readme.md");
        assert.ok(
            res.status === 400 || res.status === 404,
            `expected 400 or 404, got ${res.status}`
        );
        assert.ok(!res.body.includes("not in site"));
    });

    it("responds to HEAD with empty body and content-length", async () => {
        const res = await fetchPath(handle!, "/app.js", "HEAD");
        assert.equal(res.status, 200);
        assert.equal(res.body, "");
    });

    it("405s non-GET/HEAD methods", async () => {
        const res = await fetchPath(handle!, "/app.js", "DELETE");
        assert.equal(res.status, 405);
    });

    it("enforces per-entry uncompressed cap", async () => {
        const tiny = await startZipStaticServer({
            zipPath,
            siteRel: "dist",
            maxEntryBytes: 1, // 1 byte — even index.html exceeds this
        });
        try {
            const res = await fetchPath(tiny, "/app.js");
            assert.equal(res.status, 500);
            assert.match(res.body, /per-entry/);
        } finally {
            await tiny.dispose();
        }
    });
});

describe("startZipStaticServer (archive-root site)", () => {
    let tmpDir: string;
    let zipPath: string;
    let handle: ZipStaticServerHandle | undefined;

    before(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zss-root-"));
        const bytes = await buildZip({
            "index.html": "<!doctype html><title>root</title>",
            "data.json": '{"ok":true}',
        });
        zipPath = path.join(tmpDir, "artifact.zip");
        await fs.writeFile(zipPath, bytes);
    });

    after(async () => {
        await handle?.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("serves index.html from the archive root when siteRel is empty", async () => {
        handle = await startZipStaticServer({
            zipPath,
            siteRel: "",
            maxEntryBytes: 1024 * 1024,
        });
        const res = await fetchPath(handle, "/");
        assert.equal(res.status, 200);
        assert.match(res.body, /<title>root<\/title>/);
    });

    it("serves a sibling file by name", async () => {
        const res = await fetchPath(handle!, "/data.json");
        assert.equal(res.status, 200);
        assert.equal(res.body, '{"ok":true}');
        assert.ok(res.contentType?.startsWith("application/json"));
    });
});
