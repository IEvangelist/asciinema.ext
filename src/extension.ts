import * as vscode from "vscode";
import { CastPreviewProvider } from "./cast-preview-provider.js";
import { openFromPullRequestCommand } from "./remote/open-from-pull-request.js";
import { cleanupOlderSessions } from "./remote/temp-storage.js";

export function activate(context: vscode.ExtensionContext): void {
    const provider = new CastPreviewProvider(context);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            "asciinema.castPreview",
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("asciinema.openAsText", async () => {
            const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (activeTab?.input instanceof vscode.TabInputCustom) {
                await vscode.commands.executeCommand(
                    "vscode.openWith",
                    activeTab.input.uri,
                    "default"
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "asciinema.openFromPullRequest",
            () => openFromPullRequestCommand(context)
        )
    );

    // Best-effort cleanup of temp casts from prior sessions.
    void cleanupOlderSessions(context);
}

export function deactivate(): void {
    // No-op
}
