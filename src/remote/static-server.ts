import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { AddressInfo } from "node:net";

export interface StaticServerOptions {
    /** Absolute filesystem path served as the document root. */
    readonly root: string;
    /**
     * Optional callback invoked for each completed request. Used by callers
     * to render request log lines in a Pseudoterminal.
     */
    readonly onRequest?: (line: StaticRequestLog) => void;
}

export interface StaticRequestLog {
    readonly status: number;
    readonly method: string;
    readonly url: string;
    readonly bytes: number;
}

export interface StaticServerHandle {
    /** Origin URL such as `http://127.0.0.1:54321`. */
    readonly url: string;
    /** Resolved port the server is listening on. */
    readonly port: number;
    /** Stops the server. Safe to call more than once. */
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

/**
 * Resolves a URL pathname against `root` while preventing path traversal.
 * Returns the absolute on-disk path or `undefined` if the request would
 * escape the root.
 */
export function resolveStaticRequest(
    root: string,
    urlPath: string
): string | undefined {
    let pathname: string;
    try {
        pathname = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
    } catch {
        return undefined;
    }
    if (!pathname || pathname[0] !== "/") {
        pathname = `/${pathname ?? ""}`;
    }
    const normalized = pathname.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized.split("/").some((seg) => seg === "..")) {
        return undefined;
    }
    const resolved = path.resolve(root, "." + normalized);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return undefined;
    }
    return resolved;
}

const NOT_FOUND_BODY =
    "<!doctype html><meta charset=\"utf-8\"><title>404 — Not Found</title>" +
    "<body style=\"font-family:sans-serif;padding:2rem;\">" +
    "<h1>404 — Not Found</h1><p>The requested resource was not served from the artifact root.</p></body>";

/**
 * Boots a small HTTP server that serves files from `options.root` on a
 * loopback port chosen by the OS. Resolves once `listen` succeeds.
 */
export function startStaticServer(
    options: StaticServerOptions
): Promise<StaticServerHandle> {
    return new Promise((resolve, reject) => {
        const root = path.resolve(options.root);
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

            const resolved = resolveStaticRequest(root, reqUrl);
            if (!resolved) {
                respond(400, "Bad Request", "text/plain; charset=utf-8");
                return;
            }

            fs.lstat(resolved, (statErr, stat) => {
                if (statErr || !stat) {
                    respond(404, NOT_FOUND_BODY, "text/html; charset=utf-8");
                    return;
                }
                // Defense-in-depth: refuse to follow symlinks placed inside
                // the served root. Zip extraction already rejects symlink
                // entries, but a manually-tampered cache directory shouldn't
                // be able to exfiltrate arbitrary files via the loopback
                // server either.
                if (stat.isSymbolicLink()) {
                    respond(404, NOT_FOUND_BODY, "text/html; charset=utf-8");
                    return;
                }
                if (stat.isDirectory()) {
                    const indexPath = path.join(resolved, "index.html");
                    fs.lstat(indexPath, (indexErr, indexStat) => {
                        if (
                            indexErr ||
                            !indexStat ||
                            indexStat.isSymbolicLink() ||
                            !indexStat.isFile()
                        ) {
                            respond(
                                404,
                                NOT_FOUND_BODY,
                                "text/html; charset=utf-8"
                            );
                            return;
                        }
                        serveFile(indexPath);
                    });
                    return;
                }
                if (!stat.isFile()) {
                    respond(404, NOT_FOUND_BODY, "text/html; charset=utf-8");
                    return;
                }
                serveFile(resolved);
            });

            function serveFile(target: string): void {
                fs.readFile(target, (readErr, data) => {
                    if (readErr) {
                        respond(404, NOT_FOUND_BODY, "text/html; charset=utf-8");
                        return;
                    }
                    if (method === "HEAD") {
                        res.writeHead(200, {
                            "Content-Type": lookupMime(target),
                            "Content-Length": data.byteLength.toString(),
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
                    respond(200, data, lookupMime(target));
                });
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
            const handle: StaticServerHandle = {
                url,
                port: addr.port,
                dispose: () =>
                    new Promise((resolveClose) => {
                        server.close(() => resolveClose());
                        // Force-close keep-alive sockets so dispose resolves quickly.
                        // Type cast — closeAllConnections is Node 18.2+ but typed in @types/node.
                        const s = server as http.Server & {
                            closeAllConnections?: () => void;
                        };
                        s.closeAllConnections?.();
                    }),
            };
            resolve(handle);
        });
    });
}
