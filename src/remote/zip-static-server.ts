import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { AddressInfo } from "node:net";
import JSZip from "jszip";
import {
    resolveStaticRequest,
    type StaticRequestLog,
} from "./static-server.js";
import { ZipLimitError } from "./artifact-zip.js";

export interface ZipStaticServerOptions {
    /**
     * Absolute filesystem path of the cached artifact `.zip`. Loaded into a
     * JSZip instance on first request and cached for the server's lifetime.
     */
    readonly zipPath: string;
    /**
     * Posix-style site root *inside* the zip. Use `.` (or an empty string)
     * when `index.html` lives at the archive root; otherwise the directory
     * holding `index.html` (e.g. `dist`, `site`).
     */
    readonly siteRel: string;
    /**
     * Maximum uncompressed size in bytes of any single entry we'll inflate
     * to satisfy a request. Mirrors `asciinema.maxArtifactEntrySizeMB`.
     */
    readonly maxEntryBytes: number;
    /** Optional callback invoked for each completed request. */
    readonly onRequest?: (line: StaticRequestLog) => void;
    /**
     * Soft memory cap for the per-server decompressed-entry LRU. Defaults
     * to 32 MB. Set to `0` to disable caching entirely.
     */
    readonly maxCacheBytes?: number;
}

export interface ZipStaticServerHandle {
    readonly url: string;
    readonly port: number;
    readonly dispose: () => Promise<void>;
}

const MIME: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
};

function lookupMime(filePath: string): string {
    return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const NOT_FOUND_BODY =
    "<!doctype html><meta charset=\"utf-8\"><title>404 — Not Found</title>" +
    "<body style=\"font-family:sans-serif;padding:2rem;\">" +
    "<h1>404 — Not Found</h1><p>The requested resource was not served from the artifact zip.</p></body>";

const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

/** Tiny LRU keyed by zip-relative posix path. */
class EntryCache {
    private readonly limit: number;
    private size = 0;
    private readonly map = new Map<string, Uint8Array>();

    constructor(limit: number) {
        this.limit = Math.max(0, limit);
    }

    get(key: string): Uint8Array | undefined {
        if (this.limit === 0) {
            return undefined;
        }
        const v = this.map.get(key);
        if (v === undefined) {
            return undefined;
        }
        // Refresh recency: re-insert at the end of the iteration order.
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    put(key: string, bytes: Uint8Array): void {
        if (this.limit === 0 || bytes.byteLength > this.limit) {
            return;
        }
        const existing = this.map.get(key);
        if (existing) {
            this.size -= existing.byteLength;
            this.map.delete(key);
        }
        this.map.set(key, bytes);
        this.size += bytes.byteLength;
        while (this.size > this.limit) {
            const oldestKey = this.map.keys().next().value as string | undefined;
            if (oldestKey === undefined) {
                break;
            }
            const oldest = this.map.get(oldestKey);
            this.map.delete(oldestKey);
            if (oldest) {
                this.size -= oldest.byteLength;
            }
        }
    }

    clear(): void {
        this.map.clear();
        this.size = 0;
    }
}

/**
 * Resolves a posix-style relative path against the site root inside the
 * zip. Returns a posix-style key suitable for a zip-entry lookup, or
 * `undefined` if the request would escape the root.
 */
export function resolveZipRequest(
    siteRel: string,
    urlPath: string
): string | undefined {
    // Re-use the disk static-server's traversal guard, then re-encode the
    // result as a posix-style entry path.
    const fakeRoot = process.platform === "win32" ? "C:\\zip-root" : "/zip-root";
    const resolved = resolveStaticRequest(fakeRoot, urlPath);
    if (resolved === undefined) {
        return undefined;
    }
    const rel = path
        .relative(fakeRoot, resolved)
        .split(path.sep)
        .join("/");
    const normalizedSite = siteRel.replace(/^\.?\/*/, "").replace(/\/+$/, "");
    if (rel === "" || rel === ".") {
        return normalizedSite === "" ? "" : `${normalizedSite}`;
    }
    return normalizedSite === "" ? rel : `${normalizedSite}/${rel}`;
}

interface LoadedZip {
    readonly jszip: JSZip;
    readonly entries: ReadonlyMap<string, JSZip.JSZipObject>;
    readonly directories: ReadonlySet<string>;
}

/**
 * Boots a small HTTP server that serves entries from `options.zipPath` on
 * a loopback port chosen by the OS. The zip is parsed once (central
 * directory only) on the first request and re-used for the server's
 * lifetime; on `dispose()` the JSZip reference is dropped so its
 * compressed-bytes buffer can be GC'd.
 */
export function startZipStaticServer(
    options: ZipStaticServerOptions
): Promise<ZipStaticServerHandle> {
    return new Promise((resolve, reject) => {
        const cache = new EntryCache(
            options.maxCacheBytes ?? DEFAULT_CACHE_BYTES
        );
        let loaded: Promise<LoadedZip> | undefined;

        const loadZip = (): Promise<LoadedZip> => {
            if (loaded) {
                return loaded;
            }
            loaded = (async () => {
                const buf = await fs.readFile(options.zipPath);
                const u8 = new Uint8Array(
                    buf.buffer,
                    buf.byteOffset,
                    buf.byteLength
                );
                const jszip = await JSZip.loadAsync(u8);
                const entries = new Map<string, JSZip.JSZipObject>();
                const directories = new Set<string>();
                for (const obj of Object.values(jszip.files)) {
                    const key = obj.name.replace(/\\/g, "/").replace(/\/+$/, "");
                    if (obj.dir) {
                        directories.add(key);
                        continue;
                    }
                    entries.set(key, obj);
                    // Synthesize parent directory entries so a request like
                    // `/dist/` resolves to its `index.html` even when the
                    // archive omits explicit directory entries.
                    let parent = key;
                    for (;;) {
                        const slash = parent.lastIndexOf("/");
                        if (slash < 0) {
                            break;
                        }
                        parent = parent.slice(0, slash);
                        if (directories.has(parent)) {
                            break;
                        }
                        directories.add(parent);
                    }
                }
                return { jszip, entries, directories };
            })();
            return loaded;
        };

        const server = http.createServer((req, res) => {
            const method = req.method ?? "GET";
            const reqUrl = req.url ?? "/";

            const respond = (
                status: number,
                body: Buffer | string,
                contentType: string
            ): void => {
                const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
                res.writeHead(status, {
                    "Content-Type": contentType,
                    "Content-Length": buf.byteLength.toString(),
                    "Cache-Control": "no-store",
                });
                res.end(buf);
                options.onRequest?.({
                    status,
                    method,
                    url: reqUrl,
                    bytes: buf.byteLength,
                });
            };

            if (method !== "GET" && method !== "HEAD") {
                respond(405, "Method Not Allowed", "text/plain; charset=utf-8");
                return;
            }

            const entryKey = resolveZipRequest(options.siteRel, reqUrl);
            if (entryKey === undefined) {
                respond(400, "Bad Request", "text/plain; charset=utf-8");
                return;
            }

            void serveEntry(entryKey).catch((err) => {
                if (err instanceof ZipLimitError) {
                    respond(
                        500,
                        `Entry exceeds the per-entry uncompressed cap: ${err.message}`,
                        "text/plain; charset=utf-8"
                    );
                    return;
                }
                respond(
                    500,
                    `Server error: ${(err as Error)?.message ?? String(err)}`,
                    "text/plain; charset=utf-8"
                );
            });

            async function serveEntry(key: string): Promise<void> {
                const { entries, directories } = await loadZip();

                let candidateKey: string | undefined = entries.has(key)
                    ? key
                    : undefined;

                // Directory request: serve its `index.html`.
                if (!candidateKey) {
                    const isDirectory =
                        key === "" || directories.has(key);
                    if (isDirectory) {
                        const indexKey = key === "" ? "index.html" : `${key}/index.html`;
                        if (entries.has(indexKey)) {
                            candidateKey = indexKey;
                        }
                    }
                }

                if (!candidateKey) {
                    respond(404, NOT_FOUND_BODY, "text/html; charset=utf-8");
                    return;
                }

                const cached = cache.get(candidateKey);
                let bytes: Uint8Array;
                if (cached) {
                    bytes = cached;
                } else {
                    const entry = entries.get(candidateKey)!;
                    bytes = await entry.async("uint8array");
                    if (bytes.byteLength > options.maxEntryBytes) {
                        throw new ZipLimitError(
                            `Entry "${candidateKey}" is ${Math.round(
                                bytes.byteLength / 1024 / 1024
                            )} MB, exceeding the ${Math.round(
                                options.maxEntryBytes / 1024 / 1024
                            )} MB per-entry cap.`,
                            "entrySize",
                            options.maxEntryBytes,
                            bytes.byteLength
                        );
                    }
                    cache.put(candidateKey, bytes);
                }

                const contentType = lookupMime(candidateKey);
                if (method === "HEAD") {
                    res.writeHead(200, {
                        "Content-Type": contentType,
                        "Content-Length": bytes.byteLength.toString(),
                        "Cache-Control": "no-store",
                    });
                    res.end();
                    options.onRequest?.({
                        status: 200,
                        method,
                        url: reqUrl,
                        bytes: 0,
                    });
                    return;
                }

                respond(200, Buffer.from(bytes), contentType);
            }
        });

        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo | null;
            if (!addr || typeof addr === "string") {
                server.close();
                reject(new Error("Failed to bind static server to a loopback port."));
                return;
            }
            const url = `http://127.0.0.1:${addr.port}`;
            const handle: ZipStaticServerHandle = {
                url,
                port: addr.port,
                dispose: () =>
                    new Promise((resolveClose) => {
                        server.close(() => resolveClose());
                        const s = server as http.Server & {
                            closeAllConnections?: () => void;
                        };
                        s.closeAllConnections?.();
                        cache.clear();
                        loaded = undefined;
                    }),
            };
            resolve(handle);
        });
    });
}
