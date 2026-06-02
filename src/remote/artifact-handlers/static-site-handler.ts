import * as vscode from "vscode";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
    ArtifactHandler,
    HandlerCandidate,
    HandlerContext,
} from "./handler-types.js";
import { detectStaticSite, type SiteDetection } from "./detect-static-site.js";
import {
    startStaticServer,
    type StaticServerHandle,
    type StaticRequestLog,
} from "../static-server.js";
import {
    startZipStaticServer,
    type ZipStaticServerHandle,
} from "../zip-static-server.js";
import {
    previewRegistry,
    type ActivePreview,
} from "../preview-registry.js";

interface StaticCandidateData {
    readonly site: SiteDetection;
}

type OpenTarget = "simple-browser" | "external";

const DEFAULT_MAX_ENTRY_SIZE_MB = 500;

function getMaxEntryBytes(): number {
    const mb = vscode.workspace
        .getConfiguration("asciinema")
        .get<number>("maxArtifactEntrySizeMB", DEFAULT_MAX_ENTRY_SIZE_MB);
    const safe = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_ENTRY_SIZE_MB;
    return Math.round(safe * 1024 * 1024);
}

export const staticSiteHandler: ArtifactHandler = {
    detect(ctx: HandlerContext): HandlerCandidate | null {
        const site = detectStaticSite({ files: ctx.bundle.files });
        if (!site) {
            return null;
        }
        const siteLabel =
            site.siteRel === "."
                ? "(artifact root)"
                : `${site.siteRel}/`;
        return {
            id: "static-site",
            icon: "$(browser)",
            label: "Preview HTML site",
            description: `site root: ${siteLabel} · ${site.fileCount} ${
                site.fileCount === 1 ? "file" : "files"
            }`,
            detail: `Served directly from the cached zip — no disk extraction.`,
            priority: 30,
            data: { site } satisfies StaticCandidateData,
        };
    },

    async open(ctx: HandlerContext, candidate: HandlerCandidate): Promise<void> {
        const data = candidate.data as StaticCandidateData;
        const target = await pickOpenTarget();
        if (!target) {
            return;
        }
        await launchStaticPreview(ctx, data.site, target);
    },
};

async function pickOpenTarget(): Promise<OpenTarget | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: "$(window)  Open in VS Code (Simple Browser)",
                description: "Preview side-by-side without leaving the editor",
                value: "simple-browser" as const,
            },
            {
                label: "$(link-external)  Open in default browser",
                description: "Launch your OS's default web browser",
                value: "external" as const,
            },
        ],
        {
            title: "Where would you like to open this site?",
            placeHolder: "Pick a browser",
            ignoreFocusOut: true,
        }
    );
    return choice?.value;
}

type AnyServerHandle = StaticServerHandle | ZipStaticServerHandle;

export async function launchStaticPreview(
    ctx: HandlerContext,
    site: SiteDetection,
    target: OpenTarget
): Promise<void> {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    let server: AnyServerHandle | undefined;
    const previewId = randomUUID();
    const previewName = `Static Site Preview — ${ctx.artifact.name}`;

    // Choose backend: zip-backed when we only have the cached zip;
    // legacy disk-backed when re-opening a v2-era recent.
    const usingZipBackend = ctx.extracted === undefined;

    let registered = false;
    let stopping = false;

    const stopServer = async (): Promise<void> => {
        if (stopping) {
            return;
        }
        stopping = true;
        try {
            await server?.dispose();
        } catch {
            // best-effort
        }
        server = undefined;
        if (registered) {
            previewRegistry.unregister(previewId);
            registered = false;
        }
    };

    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: async () => {
            const rootLabel = usingZipBackend
                ? `zip: ${path.basename(ctx.bundle.zipPath.fsPath)}`
                : `dir: ${resolveExtractedSiteRoot(ctx, site)}`;
            const siteLabel =
                site.siteRel === "." ? "(archive root)" : `${site.siteRel}/`;
            writeEmitter.fire(
                ansi.cyan("▶ Static site preview\r\n") +
                    ansi.dim(`  ${rootLabel}\r\n`) +
                    ansi.dim(`  site root: ${siteLabel}\r\n\r\n`)
            );
            try {
                if (usingZipBackend) {
                    server = await startZipStaticServer({
                        zipPath: ctx.bundle.zipPath.fsPath,
                        siteRel: site.siteRel === "." ? "" : site.siteRel,
                        maxEntryBytes: getMaxEntryBytes(),
                        onRequest: (log) => {
                            writeEmitter.fire(formatRequestLog(log) + "\r\n");
                        },
                    });
                } else {
                    server = await startStaticServer({
                        root: resolveExtractedSiteRoot(ctx, site),
                        onRequest: (log) => {
                            writeEmitter.fire(formatRequestLog(log) + "\r\n");
                        },
                    });
                }
            } catch (err) {
                writeEmitter.fire(
                    ansi.red(
                        `Failed to start server: ${(err as Error).message}\r\n`
                    )
                );
                closeEmitter.fire(1);
                return;
            }
            const url = server.url;
            const startedAt = Date.now();
            const preview: ActivePreview = {
                id: previewId,
                artifactName: ctx.artifact.name,
                url,
                startedAt,
                deleteArtifactCache: ctx.deleteArtifactCache,
                dispose: async () => {
                    await stopServer();
                    try {
                        terminal.dispose();
                    } catch {
                        // best-effort
                    }
                },
            };
            previewRegistry.register(preview);
            registered = true;

            writeEmitter.fire(
                ansi.green(`Listening on ${url}\r\n`) +
                    ansi.dim(
                        `  Press Ctrl+C, close this terminal, or run\r\n` +
                            `  "GitHub Artifacts: Stop HTML preview" to stop.\r\n\r\n`
                    )
            );
            if (target === "simple-browser") {
                void vscode.commands.executeCommand(
                    "simpleBrowser.show",
                    url
                );
            } else {
                void vscode.env.openExternal(vscode.Uri.parse(url));
            }
        },
        close: () => {
            void stopServer();
        },
        handleInput: (data: string) => {
            // 0x03 = Ctrl+C — let the user stop the server from inside its
            // own terminal without having to dispose the tab.
            if (data.includes("\x03")) {
                writeEmitter.fire(
                    "\r\n" + ansi.yellow("^C — stopping preview…\r\n")
                );
                void stopServer().then(() => {
                    closeEmitter.fire(0);
                });
            }
        },
    };

    const terminal = vscode.window.createTerminal({ name: previewName, pty });
    terminal.show(true);

    const disposable: vscode.Disposable = {
        dispose: () => {
            void stopServer();
            try {
                terminal.dispose();
            } catch {
                // ignore
            }
            writeEmitter.dispose();
            closeEmitter.dispose();
        },
    };
    ctx.extensionContext.subscriptions.push(disposable);
}

function resolveExtractedSiteRoot(
    ctx: HandlerContext,
    site: SiteDetection
): string {
    const root = ctx.extracted?.rootDir.fsPath ?? "";
    if (site.siteRel === ".") {
        return root;
    }
    return path.join(root, ...site.siteRel.split("/"));
}

function formatRequestLog(log: StaticRequestLog): string {
    const statusColor =
        log.status >= 500
            ? ansi.red
            : log.status >= 400
              ? ansi.yellow
              : ansi.green;
    return `${statusColor(String(log.status))} ${log.method} ${log.url}`;
}

const ansi = {
    cyan: (s: string): string => `\x1b[36m${s}\x1b[0m`,
    red: (s: string): string => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string): string => `\x1b[33m${s}\x1b[0m`,
    green: (s: string): string => `\x1b[32m${s}\x1b[0m`,
    dim: (s: string): string => `\x1b[2m${s}\x1b[0m`,
};
