import * as vscode from "vscode";
import { runExploreRepositoryFlow } from "./explore-repository-flow.js";
import { parseRepositoryUrl } from "./parse-repo-url.js";
import { showPaletteNotice } from "./quick-input.js";

export async function openFromRepositoryCommand(
    context: vscode.ExtensionContext,
    options: { prefilledUrl?: string } = {}
): Promise<void> {
    let rawUrl = options.prefilledUrl;
    if (!rawUrl) {
        rawUrl = await vscode.window.showInputBox({
            title: "GitHub Artifacts — Explore Repository",
            prompt: "Paste a GitHub repository URL",
            placeHolder: "https://github.com/owner/repo",
            ignoreFocusOut: true,
            validateInput: (value) =>
                !value || parseRepositoryUrl(value)
                    ? undefined
                    : "Not a recognized GitHub repository URL",
        });
        if (!rawUrl) {
            return;
        }
    }

    const repo = parseRepositoryUrl(rawUrl);
    if (!repo) {
        await showPaletteNotice(
            "GitHub Artifacts — repository URL not recognized",
            "That doesn't look like a GitHub repository URL.",
            "error"
        );
        return;
    }

    await runExploreRepositoryFlow(context, repo);
}

export { parseRepositoryUrl };
