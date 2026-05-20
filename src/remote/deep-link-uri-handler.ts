import * as vscode from "vscode";
import { parseDeepLink } from "./deep-link.js";
import { openFromPullRequestCommand } from "./open-from-pull-request.js";

export function registerDeepLinkUriHandler(
    context: vscode.ExtensionContext
): vscode.Disposable {
    return vscode.window.registerUriHandler({
        async handleUri(uri: vscode.Uri): Promise<void> {
            const parsed = parseDeepLink(uri.path, uri.query);
            if (!parsed.ok) {
                await vscode.window.showErrorMessage(
                    `GitHub Artifacts — ${parsed.message}`
                );
                return;
            }

            try {
                await openFromPullRequestCommand(context, {
                    prefilledUrl: parsed.url,
                });
            } catch (err) {
                console.error("[asciinema] deep link failed:", err);
                await vscode.window.showErrorMessage(
                    `GitHub Artifacts — deep link failed: ${(err as Error)?.message ?? String(err)}`
                );
            }
        },
    });
}
