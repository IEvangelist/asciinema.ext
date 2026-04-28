import * as vscode from "vscode";
import type {
    ArtifactHandler,
    HandlerCandidate,
    HandlerContext,
} from "./handler-types.js";
import { castHandler } from "./cast-handler.js";
import { astroSiteHandler } from "./astro-site-handler.js";
import { staticSiteHandler } from "./static-site-handler.js";
import { showQuickPick } from "./quickpick.js";

const HANDLERS: readonly ArtifactHandler[] = [
    castHandler,
    astroSiteHandler,
    staticSiteHandler,
];

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
            label: "$(folder-opened)  Reveal extracted files in Explorer",
            description: "Browse the artifact contents",
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
    await vscode.commands.executeCommand(
        "revealInExplorer",
        ctx.extracted.rootDir
    );
    await vscode.window.showInformationMessage(
        `Asciinema — extracted artifact "${ctx.artifact.name}" to ${ctx.extracted.rootDir.fsPath}`
    );
}
