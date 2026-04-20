import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { parsePullRequestUrl } from "../parse-pr-url.js";
import { sanitizeCastFileName } from "../sanitize.js";
import { extractCastEntries, ZipLimitError } from "../artifact-zip.js";

describe("parsePullRequestUrl", () => {
    it("parses canonical PR URL", () => {
        const result = parsePullRequestUrl(
            "https://github.com/octocat/hello-world/pull/42"
        );
        assert.deepEqual(result, {
            owner: "octocat",
            repo: "hello-world",
            number: 42,
        });
    });

    it("tolerates /files suffix", () => {
        const result = parsePullRequestUrl(
            "https://github.com/octocat/hello-world/pull/42/files"
        );
        assert.equal(result?.number, 42);
    });

    it("tolerates /commits suffix", () => {
        const result = parsePullRequestUrl(
            "https://github.com/octocat/hello-world/pull/42/commits"
        );
        assert.equal(result?.number, 42);
    });

    it("tolerates trailing slash", () => {
        assert.equal(
            parsePullRequestUrl("https://github.com/a/b/pull/1/")?.number,
            1
        );
    });

    it("tolerates query strings and fragments", () => {
        assert.equal(
            parsePullRequestUrl("https://github.com/a/b/pull/1?w=1")?.number,
            1
        );
        assert.equal(
            parsePullRequestUrl("https://github.com/a/b/pull/1#issuecomment")
                ?.number,
            1
        );
    });

    it("is case-insensitive on scheme/host", () => {
        assert.equal(
            parsePullRequestUrl("HTTPS://GitHub.com/a/b/pull/7")?.number,
            7
        );
    });

    it("rejects issue URLs", () => {
        assert.equal(
            parsePullRequestUrl("https://github.com/a/b/issues/1"),
            undefined
        );
    });

    it("rejects non-GitHub hosts", () => {
        assert.equal(
            parsePullRequestUrl("https://gitlab.com/a/b/pull/1"),
            undefined
        );
    });

    it("rejects empty or non-string input", () => {
        assert.equal(parsePullRequestUrl(""), undefined);
        assert.equal(
            parsePullRequestUrl(undefined as unknown as string),
            undefined
        );
    });

    it("rejects non-positive PR numbers", () => {
        assert.equal(
            parsePullRequestUrl("https://github.com/a/b/pull/0"),
            undefined
        );
    });
});

describe("sanitizeCastFileName", () => {
    it("produces a hash-prefixed .cast filename", () => {
        const name = sanitizeCastFileName("foo/bar.cast");
        assert.match(name, /^[0-9a-f]{12}-bar\.cast$/);
    });

    it("disambiguates same basename in different paths", () => {
        const a = sanitizeCastFileName("dir-a/foo.cast");
        const b = sanitizeCastFileName("dir-b/foo.cast");
        assert.notEqual(a, b);
    });

    it("strips traversal segments from the basename only", () => {
        const name = sanitizeCastFileName("../../etc/passwd.cast");
        assert.match(name, /^[0-9a-f]{12}-passwd\.cast$/);
        assert.ok(!name.includes(".."));
        assert.ok(!name.includes("/"));
    });

    it("replaces non-ASCII characters", () => {
        const name = sanitizeCastFileName("recordings/日本語.cast");
        assert.match(name, /^[0-9a-f]{12}-[A-Za-z0-9._-]+\.cast$/);
    });

    it("falls back to 'cast' when basename is entirely unsafe", () => {
        const name = sanitizeCastFileName("!!!.cast");
        assert.match(name, /^[0-9a-f]{12}-cast\.cast$/);
    });

    it("throws on empty path", () => {
        assert.throws(() => sanitizeCastFileName(""));
    });

    it("is deterministic for the same path", () => {
        assert.equal(
            sanitizeCastFileName("x/y/z.cast"),
            sanitizeCastFileName("x/y/z.cast")
        );
    });
});

async function buildZip(
    files: Array<{ name: string; content: string | Uint8Array }>
): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const f of files) {
        zip.file(f.name, f.content);
    }
    return await zip.generateAsync({ type: "uint8array" });
}

describe("extractCastEntries", () => {
    it("returns only .cast entries", async () => {
        const bytes = await buildZip([
            { name: "readme.txt", content: "hi" },
            { name: "demo.cast", content: '{"version":2}' },
            { name: "nested/run.cast", content: "payload" },
        ]);
        const entries = await extractCastEntries(bytes);
        const paths = entries.map((e) => e.path).sort();
        assert.deepEqual(paths, ["demo.cast", "nested/run.cast"]);
    });

    it("returns empty when no .cast entries", async () => {
        const bytes = await buildZip([{ name: "a.txt", content: "x" }]);
        const entries = await extractCastEntries(bytes);
        assert.equal(entries.length, 0);
    });

    it("is case-insensitive on .cast extension", async () => {
        const bytes = await buildZip([{ name: "RUN.CAST", content: "x" }]);
        const entries = await extractCastEntries(bytes);
        assert.equal(entries.length, 1);
    });

    it("enforces maxEntries cap", async () => {
        const files = Array.from({ length: 5 }, (_, i) => ({
            name: `f${i}.txt`,
            content: "x",
        }));
        const bytes = await buildZip(files);
        await assert.rejects(
            extractCastEntries(bytes, {
                maxEntries: 3,
                maxEntryBytes: 1_000_000,
                maxTotalCastBytes: 1_000_000,
            }),
            (err: unknown) =>
                err instanceof ZipLimitError && /entry cap/.test(err.message)
        );
    });

    it("enforces per-entry uncompressed cap", async () => {
        const bigPayload = "x".repeat(1024);
        const bytes = await buildZip([
            { name: "big.cast", content: bigPayload },
        ]);
        await assert.rejects(
            extractCastEntries(bytes, {
                maxEntries: 100,
                maxEntryBytes: 512,
                maxTotalCastBytes: 10_000,
            }),
            (err: unknown) =>
                err instanceof ZipLimitError && /per-entry cap/.test(err.message)
        );
    });

    it("enforces total uncompressed cast cap", async () => {
        const payload = "x".repeat(600);
        const bytes = await buildZip([
            { name: "a.cast", content: payload },
            { name: "b.cast", content: payload },
        ]);
        await assert.rejects(
            extractCastEntries(bytes, {
                maxEntries: 100,
                maxEntryBytes: 10_000,
                maxTotalCastBytes: 1000,
            }),
            (err: unknown) =>
                err instanceof ZipLimitError &&
                /Total uncompressed/.test(err.message)
        );
    });
});
