import * as vscode from "vscode";
import * as path from "node:path";
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

interface StaticCandidateData {
    readonly site: SiteDetection;
}

export const staticSiteHandler: ArtifactHandler = {
    async detect(ctx: HandlerContext): Promise<HandlerCandidate | null> {
        const site = await detectStaticSite(ctx.extracted);
        if (!site || site.isAstro) {
            return null;
        }
        const siteLabel =
            path.posix.dirname(site.indexRelPath) === "."
                ? "(artifact root)"
                : `${path.posix.dirname(site.indexRelPath)}/`;
        return {
            id: "static-site",
            icon: "$(server-environment)",
            label: "Preview static site",
            description: `site root: ${siteLabel} · ${site.fileCount} ${
                site.fileCount === 1 ? "file" : "files"
            }`,
            detail: `Plain HTML/CSS/JS · served via built-in HTTP server`,
            priority: 30,
            data: { site } satisfies StaticCandidateData,
        };
    },

    async open(ctx: HandlerContext, candidate: HandlerCandidate): Promise<void> {
        const data = candidate.data as StaticCandidateData;
        await launchStaticPreview(ctx, data.site);
    },
};

async function launchStaticPreview(
    ctx: HandlerContext,
    site: SiteDetection
): Promise<void> {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    let server: StaticServerHandle | undefined;
    const previewName = `Static Site Preview — ${ctx.artifact.name}`;

    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: async () => {
            writeEmitter.fire(
                ansi.cyan("▶ Static site preview\r\n") +
                    ansi.dim(`  root: ${site.siteRoot}\r\n\r\n`)
            );
            try {
                server = await startStaticServer({
                    root: site.siteRoot,
                    onRequest: (log) => {
                        writeEmitter.fire(formatRequestLog(log) + "\r\n");
                    },
                });
            } catch (err) {
                writeEmitter.fire(
                    ansi.red(
                        `Failed to start server: ${(err as Error).message}\r\n`
                    )
                );
                closeEmitter.fire(1);
                return;
            }
            writeEmitter.fire(
                ansi.green(`Listening on ${server.url}\r\n\r\n`)
            );
            void vscode.commands.executeCommand(
                "simpleBrowser.show",
                server.url
            );
        },
        close: () => {
            void server?.dispose();
        },
    };

    const terminal = vscode.window.createTerminal({ name: previewName, pty });
    terminal.show(true);

    const disposable: vscode.Disposable = {
        dispose: () => {
            void server?.dispose();
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
