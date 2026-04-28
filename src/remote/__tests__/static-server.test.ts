import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    resolveStaticRequest,
    startStaticServer,
    type StaticServerHandle,
} from "../static-server.js";

describe("resolveStaticRequest", () => {
    const root = path.resolve("/tmp/site-root");
    it("maps simple paths to inside root", () => {
        const resolved = resolveStaticRequest(root, "/index.html");
        assert.equal(resolved, path.join(root, "index.html"));
    });
    it("rejects traversal", () => {
        assert.equal(
            resolveStaticRequest(root, "/../../etc/passwd"),
            undefined
        );
        assert.equal(
            resolveStaticRequest(root, "/foo/../../bar"),
            undefined
        );
    });
    it("strips query/fragment", () => {
        const resolved = resolveStaticRequest(root, "/a.css?v=1#x");
        assert.equal(resolved, path.join(root, "a.css"));
    });
    it("handles encoded paths", () => {
        const resolved = resolveStaticRequest(
            root,
            "/sub%20dir/page.html"
        );
        assert.equal(resolved, path.join(root, "sub dir", "page.html"));
    });
    it("rejects malformed encoding", () => {
        assert.equal(resolveStaticRequest(root, "/%E0%A4%A"), undefined);
    });
});

describe("startStaticServer", () => {
    let tmpRoot: string;
    let server: StaticServerHandle | undefined;

    before(async () => {
        tmpRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "asciinema-static-")
        );
        await fs.writeFile(
            path.join(tmpRoot, "index.html"),
            "<html>hello</html>",
            "utf8"
        );
        await fs.mkdir(path.join(tmpRoot, "assets"));
        await fs.writeFile(
            path.join(tmpRoot, "assets", "main.css"),
            "body { color: red; }",
            "utf8"
        );
    });

    after(async () => {
        await server?.dispose();
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("serves files and 404s missing ones", async () => {
        const requests: Array<{ status: number; url: string }> = [];
        server = await startStaticServer({
            root: tmpRoot,
            onRequest: (log) =>
                requests.push({ status: log.status, url: log.url }),
        });

        const indexResp = await fetchText(`${server.url}/`);
        assert.equal(indexResp.status, 200);
        assert.match(indexResp.body, /hello/);

        const cssResp = await fetchText(`${server.url}/assets/main.css`);
        assert.equal(cssResp.status, 200);
        assert.equal(cssResp.headers["content-type"], "text/css; charset=utf-8");

        const missingResp = await fetchText(`${server.url}/missing.html`);
        assert.equal(missingResp.status, 404);

        assert.deepEqual(
            requests.map((r) => r.status).sort(),
            [200, 200, 404]
        );
    });

    it("rejects path traversal", async () => {
        const traversal = await fetchText(
            `${server!.url}/../../../../etc/passwd`
        );
        // Node normalizes the URL before sending so the server may receive
        // either /etc/passwd (404 because not in root) or 400. Either is a
        // safe outcome — we just need to confirm we never serve real /etc/passwd.
        assert.ok(
            traversal.status === 404 || traversal.status === 400,
            `expected 404 or 400, got ${traversal.status}`
        );
        assert.ok(!traversal.body.includes("root:"));
    });
});

interface FetchedResponse {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
}

function fetchText(url: string): Promise<FetchedResponse> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                    if (typeof v === "string") {
                        headers[k] = v;
                    }
                }
                resolve({ status: res.statusCode ?? 0, headers, body });
            });
        });
        req.on("error", reject);
    });
}
