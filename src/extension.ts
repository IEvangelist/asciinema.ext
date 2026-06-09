import * as vscode from "vscode";
import { CastPreviewProvider } from "./cast-preview-provider.js";
import { openFromPullRequestCommand } from "./remote/open-from-pull-request.js";
import { openFromActionsRunCommand } from "./remote/open-from-actions-run.js";
import { openFromRepositoryCommand } from "./remote/open-from-repository.js";
import {
    cleanupCurrentSession,
    cleanupOlderSessions,
} from "./remote/temp-storage.js";
import {
    getKnownArtifactPaths,
    initRecentArtifacts,
} from "./remote/recent-artifacts.js";
import { clearCacheCommand } from "./remote/clear-cache-command.js";
import {
    createPreviewStatusBarItem,
    stopHtmlPreviewCommand,
} from "./remote/stop-preview-command.js";
import { previewRegistry } from "./remote/preview-registry.js";
import { registerDeepLinkUriHandler } from "./remote/deep-link-uri-handler.js";
import { showPaletteNotice } from "./remote/quick-input.js";

let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Extension activation entrypoint. Called by VS Code the first time any
 * `activationEvents` from `package.json` matches.
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
            async (arg?: unknown) => {
                try {
                    await openFromPullRequestCommand(
                        context,
                        toPrefilledUrlOptions(arg)
                    );
                } catch (err) {
                    console.error(
                        "[asciinema] openFromPullRequest failed:",
                        err
                    );
                    await showPaletteNotice(
                        "GitHub Artifacts — command failed",
                        `GitHub Artifacts — command failed: ${(err as Error)?.message ?? String(err)}`,
                        "error"
                    );
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "asciinema.openFromActionsRun",
            async (arg?: unknown) => {
                try {
                    await openFromActionsRunCommand(
                        context,
                        toPrefilledUrlOptions(arg)
                    );
                } catch (err) {
                    console.error(
                        "[asciinema] openFromActionsRun failed:",
                        err
                    );
                    await showPaletteNotice(
                        "GitHub Artifacts — command failed",
                        `GitHub Artifacts — command failed: ${(err as Error)?.message ?? String(err)}`,
                        "error"
                    );
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "asciinema.exploreRepository",
            async (arg?: unknown) => {
                try {
                    await openFromRepositoryCommand(
                        context,
                        toPrefilledUrlOptions(arg)
                    );
                } catch (err) {
                    console.error(
                        "[asciinema] exploreRepository failed:",
                        err
                    );
                    await showPaletteNotice(
                        "GitHub Artifacts — command failed",
                        `GitHub Artifacts — command failed: ${(err as Error)?.message ?? String(err)}`,
                        "error"
                    );
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("asciinema.clearCache", async () => {
            try {
                await clearCacheCommand(context);
            } catch (err) {
                console.error("[asciinema] clearCache failed:", err);
                await showPaletteNotice(
                    "GitHub Artifacts — command failed",
                    `GitHub Artifacts — command failed: ${(err as Error)?.message ?? String(err)}`,
                    "error"
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "asciinema.stopHtmlPreview",
            async () => {
                try {
                    await stopHtmlPreviewCommand();
                } catch (err) {
                    console.error(
                        "[asciinema] stopHtmlPreview failed:",
                        err
                    );
                    await showPaletteNotice(
                        "GitHub Artifacts — command failed",
                        `GitHub Artifacts — command failed: ${(err as Error)?.message ?? String(err)}`,
                        "error"
                    );
                }
            }
        )
    );

    context.subscriptions.push(registerDeepLinkUriHandler(context));
    context.subscriptions.push(createPreviewStatusBarItem());

    void cleanupOlderSessions(context, getKnownArtifactPaths());
}

/**
 * Extension deactivation hook. Cleans up the current session's artifact
 * directories — `globalState` recents persist intentionally so the user can
 * re-open them after restarting VS Code. Active HTML previews are also
 * disposed so any held HTTP sockets and JSZip references are released.
 */
export async function deactivate(): Promise<void> {
    try {
        await previewRegistry.stopAll();
    } catch {
        // best-effort
    }
    if (extensionContext) {
        await cleanupCurrentSession(extensionContext);
    }
}

function toPrefilledUrlOptions(arg: unknown): { readonly prefilledUrl?: string } {
    if (typeof arg === "string") {
        return { prefilledUrl: arg };
    }
    if (
        typeof arg === "object" &&
        arg !== null &&
        "prefilledUrl" in arg &&
        typeof arg.prefilledUrl === "string"
    ) {
        return { prefilledUrl: arg.prefilledUrl };
    }
    return {};
}
