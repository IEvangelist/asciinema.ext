import * as vscode from "vscode";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
    ArtifactHandler,
    HandlerCandidate,
    HandlerContext,
} from "./handler-types.js";
import { detectStaticSite, type SiteDetection } from "./detect-static-site.js";
import { launchStaticPreview } from "./static-site-handler.js";

interface AstroCandidateData {
    readonly site: SiteDetection;
}

export const astroSiteHandler: ArtifactHandler = {
    async detect(ctx: HandlerContext): Promise<HandlerCandidate | null> {
        const site = await detectStaticSite(ctx.extracted);
        if (!site || !site.isAstro) {
            return null;
        }
        const siteLabel =
            path.posix.dirname(site.indexRelPath) === "."
                ? "(artifact root)"
                : `${path.posix.dirname(site.indexRelPath)}/`;
        return {
            id: "astro-site",
            icon: "$(globe)",
            label: "Preview Astro site",
            description: `site root: ${siteLabel} · ${site.fileCount} ${
                site.fileCount === 1 ? "file" : "files"
            }`,
            detail: `Detected via ${site.astroMarkers.join("; ")}`,
            priority: 20,
            data: { site } satisfies AstroCandidateData,
        };
    },

    async open(ctx: HandlerContext, candidate: HandlerCandidate): Promise<void> {
        const data = candidate.data as AstroCandidateData;
        await runAstroPreview(ctx, data.site);
    },
};

async function runAstroPreview(
    ctx: HandlerContext,
    site: SiteDetection
): Promise<void> {
    const installed = await isAstroInstalled();
    if (!installed) {
        const choice = await vscode.window.showWarningMessage(
            "Astro CLI not found on PATH. Install it globally with `npm install -g astro`?",
            { modal: true },
            "Install",
            "Use built-in static server"
        );
        if (choice === "Use built-in static server") {
            await launchStaticPreview(ctx, site, {
                headerNote:
                    "⚠ Astro CLI not installed — falling back to the built-in static server.",
            });
            return;
        }
        if (choice !== "Install") {
            return;
        }
        const ok = await runNpmInstallAstro();
        if (!ok) {
            const fallback = await vscode.window.showErrorMessage(
                "`npm install -g astro` did not complete successfully.",
                "Use built-in static server",
                "Cancel"
            );
            if (fallback === "Use built-in static server") {
                await launchStaticPreview(ctx, site, {
                    headerNote:
                        "⚠ Astro install failed — falling back to the built-in static server.",
                });
            }
            return;
        }
    }

    await launchAstroPreview(ctx, site);
}

function isAstroInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const proc = spawn("astro", ["--version"], {
                shell: true,
                stdio: "ignore",
            });
            proc.on("error", () => resolve(false));
            proc.on("close", (code) => resolve(code === 0));
        } catch {
            resolve(false);
        }
    });
}

async function runNpmInstallAstro(): Promise<boolean> {
    const terminal = vscode.window.createTerminal({
        name: "Install Astro",
    });
    terminal.show(true);
    terminal.sendText("npm install -g astro", true);

    // VS Code doesn't expose terminal exit codes, so wait for it to close
    // (user closes it after seeing success) and then re-check.
    return await new Promise<boolean>((resolve) => {
        const disposable = vscode.window.onDidCloseTerminal(async (t) => {
            if (t !== terminal) {
                return;
            }
            disposable.dispose();
            resolve(await isAstroInstalled());
        });
        // Safety net: also re-check after a long timeout.
        setTimeout(async () => {
            if (await isAstroInstalled()) {
                disposable.dispose();
                resolve(true);
            }
        }, 5 * 60 * 1000);
    });
}

async function launchAstroPreview(
    ctx: HandlerContext,
    site: SiteDetection
): Promise<void> {
    const previewName = `Astro Preview — ${ctx.artifact.name}`;
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    let child: ChildProcessWithoutNullStreams | undefined;
    let urlOpened = false;
    let fellBack = false;
    const urlRe = /(https?:\/\/[^\s]+)/i;

    const fallbackToStatic = (reason: string): void => {
        if (fellBack) {
            return;
        }
        fellBack = true;
        writeEmitter.fire(
            ansi.dim(
                `\r\nFalling back to built-in static server: ${reason}\r\n`
            )
        );
        // Open the static preview in its own terminal; this one will close.
        void launchStaticPreview(ctx, site, {
            headerNote: `⚠ Astro preview failed (${reason}) — using the built-in static server instead.`,
        });
    };

    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {
            writeEmitter.fire(
                ansi.cyan(`▶ astro preview\r\n`) +
                    ansi.dim(`  cwd: ${site.siteRoot}\r\n\r\n`)
            );
            try {
                child = spawn(
                    "astro",
                    ["preview", "--host", "127.0.0.1"],
                    {
                        cwd: site.siteRoot,
                        shell: true,
                        env: { ...process.env, FORCE_COLOR: "1" },
                    }
                ) as ChildProcessWithoutNullStreams;
            } catch (err) {
                writeEmitter.fire(
                    ansi.red(
                        `Failed to start astro: ${(err as Error).message}\r\n`
                    )
                );
                fallbackToStatic((err as Error).message);
                closeEmitter.fire(1);
                return;
            }

            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");

            const handleChunk = (chunk: string): void => {
                writeEmitter.fire(chunk.replace(/\r?\n/g, "\r\n"));
                if (urlOpened) {
                    return;
                }
                const match = urlRe.exec(stripAnsi(chunk));
                if (match) {
                    urlOpened = true;
                    const url = match[1].replace(/[)\]"',.]+$/g, "");
                    void vscode.commands.executeCommand(
                        "simpleBrowser.show",
                        url
                    );
                }
            };

            child.stdout.on("data", handleChunk);
            child.stderr.on("data", handleChunk);

            child.on("error", (err) => {
                writeEmitter.fire(
                    ansi.red(`\r\nastro error: ${err.message}\r\n`)
                );
                if (!urlOpened) {
                    fallbackToStatic(err.message);
                }
                closeEmitter.fire(1);
            });
            child.on("close", (code) => {
                writeEmitter.fire(
                    ansi.dim(`\r\n[astro preview exited with code ${code}]\r\n`)
                );
                if (!urlOpened) {
                    fallbackToStatic(`astro exited with code ${code ?? 0}`);
                }
                closeEmitter.fire(code ?? 0);
            });
        },
        close: () => {
            child?.kill();
        },
    };

    const terminal = vscode.window.createTerminal({ name: previewName, pty });
    terminal.show(true);

    const disposable: vscode.Disposable = {
        dispose: () => {
            try {
                child?.kill();
            } catch {
                // ignore
            }
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

function stripAnsi(input: string): string {
    // eslint-disable-next-line no-control-regex
    return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

const ansi = {
    cyan: (s: string): string => `\x1b[36m${s}\x1b[0m`,
    red: (s: string): string => `\x1b[31m${s}\x1b[0m`,
    dim: (s: string): string => `\x1b[2m${s}\x1b[0m`,
};
