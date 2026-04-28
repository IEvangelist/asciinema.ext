import * as vscode from "vscode";
import { CastPreviewProvider } from "./cast-preview-provider.js";
import { openFromPullRequestCommand } from "./remote/open-from-pull-request.js";
import {
    cleanupCurrentSession,
    cleanupOlderSessions,
} from "./remote/temp-storage.js";
import {
    getKnownArtifactDirs,
    initRecentArtifacts,
} from "./remote/recent-artifacts.js";

let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionContext = context;

    // Hydrate recents from globalState. Wrapped defensively so a corrupt
    // entry can never block command registration.
    try {
        await initRecentArtifacts(context);
    } catch (err) {
        console.error("[asciinema] Failed to load recent artifacts:", err);
    }

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
            async () => {
                try {
                    await openFromPullRequestCommand(context);
                } catch (err) {
                    console.error(
                        "[asciinema] openFromPullRequest failed:",
                        err
                    );
                    await vscode.window.showErrorMessage(
                        `Asciinema — command failed: ${(err as Error)?.message ?? String(err)}`
                    );
                }
            }
        )
    );

    void cleanupOlderSessions(context, getKnownArtifactDirs());
}

export async function deactivate(): Promise<void> {
    // Note: do NOT clear recents here — they persist via globalState so the
    // user can re-open recent artifacts after restarting VS Code.
    if (extensionContext) {
        await cleanupCurrentSession(extensionContext);
    }
}
