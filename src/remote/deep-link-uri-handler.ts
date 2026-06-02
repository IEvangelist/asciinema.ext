import * as vscode from "vscode";
import { parseDeepLink } from "./deep-link.js";
import { openFromPullRequestCommand } from "./open-from-pull-request.js";
import { showPaletteNotice } from "./quick-input.js";

export function registerDeepLinkUriHandler(
    context: vscode.ExtensionContext
): vscode.Disposable {
    return vscode.window.registerUriHandler({
        async handleUri(uri: vscode.Uri): Promise<void> {
            const parsed = parseDeepLink(uri.path, uri.query);
            if (!parsed.ok) {
                await showPaletteNotice(
                    "GitHub Artifacts — deep link",
                    `GitHub Artifacts — ${parsed.message}`,
                    "error"
                );
                return;
            }

            try {
                await openFromPullRequestCommand(context, {
                    prefilledUrl: parsed.url,
                });
            } catch (err) {
                console.error("[asciinema] deep link failed:", err);
                await showPaletteNotice(
                    "GitHub Artifacts — deep link failed",
                    `GitHub Artifacts — deep link failed: ${(err as Error)?.message ?? String(err)}`,
                    "error"
                );
            }
        },
    });
}
