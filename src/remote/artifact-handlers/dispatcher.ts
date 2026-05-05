import * as vscode from "vscode";
import type {
    ArtifactHandler,
    HandlerCandidate,
    HandlerContext,
} from "./handler-types.js";
import { castHandler } from "./cast-handler.js";
import { staticSiteHandler } from "./static-site-handler.js";
import { showQuickPick } from "./quickpick.js";

const HANDLERS: readonly ArtifactHandler[] = [castHandler, staticSiteHandler];

interface DispatchItem extends vscode.QuickPickItem {
    readonly handler?: ArtifactHandler;
    readonly candidate?: HandlerCandidate;
    readonly fallback?: "reveal";
}

/**
 * Detects every applicable handler for `ctx`, prompts the user to pick one
 * (skipping the prompt when there's exactly one specialized match), and
 * runs it. If nothing matches, reveals the extracted artifact directory in
 * the Explorer view.
 */
export async function dispatchHandler(ctx: HandlerContext): Promise<void> {
    const matches: Array<{
        handler: ArtifactHandler;
        candidate: HandlerCandidate;
    }> = [];
    for (const handler of HANDLERS) {
        const candidate = await handler.detect(ctx);
        if (candidate) {
            matches.push({ handler, candidate });
        }
    }
    matches.sort((a, b) => a.candidate.priority - b.candidate.priority);

    if (matches.length === 0) {
        await revealExtractedInExplorer(ctx);
        return;
    }

    if (matches.length === 1) {
        await matches[0].handler.open(ctx, matches[0].candidate);
        return;
    }

    const items: DispatchItem[] = [
        {
            label: "Detected handlers",
            kind: vscode.QuickPickItemKind.Separator,
        },
    ];
    for (const m of matches) {
        items.push({
            label: `${m.candidate.icon}  ${m.candidate.label}`,
            description: m.candidate.description,
            detail: m.candidate.detail,
            handler: m.handler,
            candidate: m.candidate,
        });
    }
    items.push(
        {
            label: "Other",
            kind: vscode.QuickPickItemKind.Separator,
        },
        {
            label: "$(folder-opened)  Browse extracted files…",
            description: "Open in a new window, add to workspace, or show in the OS file manager",
            detail: ctx.extracted.rootDir.fsPath,
            fallback: "reveal",
        }
    );

    const picked = await showQuickPick(items, {
        title: `Open artifact "${ctx.artifact.name}" as…`,
        placeholder: "Type to filter handlers…",
    });
    if (!picked) {
        return;
    }
    if (picked.fallback === "reveal") {
        await revealExtractedInExplorer(ctx);
        return;
    }
    if (picked.handler && picked.candidate) {
        await picked.handler.open(ctx, picked.candidate);
    }
}

async function revealExtractedInExplorer(ctx: HandlerContext): Promise<void> {
    const dir = ctx.extracted.rootDir;
    const inNewWindow = "$(empty-window)  Open folder in new VS Code window";
    const addToWorkspace = "$(multiple-windows)  Add folder to current workspace";
    const showInOs = `$(file-directory)  Show in ${osFileManagerName()}`;
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: inNewWindow,
                description: "Treat the artifact as a workspace",
                detail: dir.fsPath,
                value: "new" as const,
            },
            {
                label: addToWorkspace,
                description: "Mount it as an additional folder in this window",
                detail: dir.fsPath,
                value: "add" as const,
            },
            {
                label: showInOs,
                description: "Open in the system file manager",
                detail: dir.fsPath,
                value: "os" as const,
            },
        ],
        {
            title: `Browse extracted artifact "${ctx.artifact.name}"`,
            placeHolder: "How would you like to browse the files?",
            ignoreFocusOut: true,
        }
    );
    if (!choice) {
        return;
    }

    try {
        switch (choice.value) {
            case "new":
                await vscode.commands.executeCommand("vscode.openFolder", dir, {
                    forceNewWindow: true,
                });
                return;
            case "add": {
                const existing = vscode.workspace.workspaceFolders ?? [];
                const inserted = vscode.workspace.updateWorkspaceFolders(
                    existing.length,
                    null,
                    {
                        uri: dir,
                        name: `artifact: ${ctx.artifact.name}`,
                    }
                );
                if (!inserted) {
                    // updateWorkspaceFolders returns false if the folder is
                    // already there or VS Code refused — fall back to opening
                    // it in a new window so the user still ends up somewhere.
                    await vscode.commands.executeCommand(
                        "vscode.openFolder",
                        dir,
                        { forceNewWindow: true }
                    );
                }
                return;
            }
            case "os":
                await vscode.env.openExternal(dir);
                return;
        }
    } catch (err) {
        await vscode.window.showErrorMessage(
            `Couldn't open ${dir.fsPath}: ${(err as Error).message}`
        );
    }
}

function osFileManagerName(): string {
    switch (process.platform) {
        case "win32":
            return "File Explorer";
        case "darwin":
            return "Finder";
        default:
            return "file manager";
    }
}
