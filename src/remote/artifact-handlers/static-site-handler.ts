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

type OpenTarget = "simple-browser" | "external";

export const staticSiteHandler: ArtifactHandler = {
    async detect(ctx: HandlerContext): Promise<HandlerCandidate | null> {
        const site = await detectStaticSite(ctx.extracted);
        if (!site) {
            return null;
        }
        const siteLabel =
            path.posix.dirname(site.indexRelPath) === "."
                ? "(artifact root)"
                : `${path.posix.dirname(site.indexRelPath)}/`;
        return {
            id: "static-site",
            icon: "$(browser)",
            label: "Preview HTML site",
            description: `site root: ${siteLabel} · ${site.fileCount} ${
                site.fileCount === 1 ? "file" : "files"
            }`,
            detail: `Serve via built-in HTTP server, then open in your chosen browser`,
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

export async function launchStaticPreview(
    ctx: HandlerContext,
    site: SiteDetection,
    target: OpenTarget
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
                ansi.green(`Listening on ${server.url}\r\n`) +
                    ansi.dim(
                        `  (close this terminal to stop the server)\r\n\r\n`
                    )
            );
            if (target === "simple-browser") {
                void vscode.commands.executeCommand(
                    "simpleBrowser.show",
                    server.url
                );
            } else {
                void vscode.env.openExternal(vscode.Uri.parse(server.url));
            }
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
