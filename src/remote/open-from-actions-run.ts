import * as vscode from "vscode";
import {
    parseActionsRunUrl,
} from "./parse-run-url.js";
import { runActionsRunFlow } from "./actions-run-flow.js";

/**
 * Command implementation for `asciinema.openFromActionsRun`.
 *
 * Accepts a GitHub Actions workflow-run URL, fetches the run summary and its
 * artifacts directly (no PR head-SHA resolution), and routes through the
 * shared artifact pick/download/extract/dispatch pipeline.
 */
export async function openFromActionsRunCommand(
    context: vscode.ExtensionContext,
    options: { prefilledUrl?: string } = {}
): Promise<void> {
    let rawUrl = options.prefilledUrl;
    if (!rawUrl) {
        rawUrl = await vscode.window.showInputBox({
            title: "GitHub Artifacts — Open from CI Run",
            prompt: "Paste a GitHub Actions workflow run URL",
            placeHolder:
                "https://github.com/owner/repo/actions/runs/1234567890",
            ignoreFocusOut: true,
            validateInput: (value) =>
                !value || parseActionsRunUrl(value)
                    ? undefined
                    : "Not a recognized GitHub Actions run URL",
        });
        if (!rawUrl) {
            return;
        }
    }

    const coords = parseActionsRunUrl(rawUrl);
    if (!coords) {
        await vscode.window.showErrorMessage(
            "That doesn't look like a GitHub Actions workflow run URL."
        );
        return;
    }

    await runActionsRunFlow(context, coords);
}

// Re-export so callers can detect whether a typed URL is a run URL without
// pulling in the parse module directly.
export { parseActionsRunUrl };
