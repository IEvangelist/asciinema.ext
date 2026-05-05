import * as vscode from "vscode";
import { CastPreviewProvider } from "./cast-preview-provider.js";
import { openFromPullRequestCommand } from "./remote/open-from-pull-request.js";
import { openFromActionsRunCommand } from "./remote/open-from-actions-run.js";
import {
    cleanupCurrentSession,
    cleanupOlderSessions,
} from "./remote/temp-storage.js";
import {
    getKnownArtifactDirs,
    initRecentArtifacts,
} from "./remote/recent-artifacts.js";

let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Extension activation entrypoint. Called by VS Code the first time any
 * `activationEvents` from `package.json` matches.
 *
 * Performs three tasks:
 *   1. Hydrates the recent-artifacts cache from `globalState` (wrapped in a
 *      try/catch so a corrupt entry cannot block command registration).
 *   2. Registers the custom editor provider for `.cast` files and the two
 *      command palette commands.
 *   3. Kicks off best-effort cleanup of orphaned artifact directories from
 *      previous sessions.
 */
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

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "asciinema.openFromActionsRun",
            async () => {
                try {
                    await openFromActionsRunCommand(context);
                } catch (err) {
                    console.error(
                        "[asciinema] openFromActionsRun failed:",
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

/**
 * Extension deactivation hook. Cleans up the current session's artifact
 * directories — `globalState` recents persist intentionally so the user can
 * re-open them after restarting VS Code.
 */
export async function deactivate(): Promise<void> {
    // Note: do NOT clear recents here — they persist via globalState so the
    // user can re-open recent artifacts after restarting VS Code.
    if (extensionContext) {
        await cleanupCurrentSession(extensionContext);
    }
}
