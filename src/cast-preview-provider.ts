import * as vscode from "vscode";
import { CastDocument } from "./cast-document.js";
import { getWebviewHtml } from "./webview-html.js";
import {
    DEFAULT_PLAYER_OPTIONS,
    isPartialPlayerOptions,
    mergeOptions,
    sanitize,
    type PartialPlayerOptions,
} from "./player-options.js";
import {
    isPlayerConfigChange,
    readGlobalOptions,
    writeGlobalOptions,
} from "./player-options-config.js";
import {
    getInstanceOverrides,
    setInstanceOverrides,
} from "./player-options-store.js";

/**
 * Provides a custom readonly editor that renders .cast files
 * using the asciinema-player in a webview.
 */
export class CastPreviewProvider
    implements vscode.CustomReadonlyEditorProvider<CastDocument>
{
    private readonly _extensionUri: vscode.Uri;

    constructor(private readonly context: vscode.ExtensionContext) {
        this._extensionUri = context.extensionUri;
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<CastDocument> {
        return CastDocument.create(uri);
    }

    async resolveCustomEditor(
        document: CastDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const webview = webviewPanel.webview;
        const mediaUri = vscode.Uri.joinPath(
            this._extensionUri,
            "dist",
            "media"
        );

        webview.options = {
            enableScripts: true,
            localResourceRoots: [mediaUri],
        };

        const playerJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, "asciinema-player.min.js")
        );
        const playerCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, "asciinema-player.css")
        );

        const buildResolution = () => {
            const global = readGlobalOptions();
            const instance = getInstanceOverrides(this.context, document.uri);
            return mergeOptions(global, instance);
        };

        webview.html = getWebviewHtml({
            webview,
            playerJsUri,
            playerCssUri,
            castContent: document.content,
            resolution: buildResolution(),
        });

        const postOptions = (): void => {
            const r = buildResolution();
            void webview.postMessage({
                type: "options",
                defaults: r.defaults,
                global: r.global,
                instance: r.instance,
                merged: r.merged,
                source: r.source,
            });
        };

        // ─── Webview → Host ───────────────────────────────────────────
        const msgSub = webview.onDidReceiveMessage(async (msg: unknown) => {
            if (!msg || typeof msg !== "object") {
                return;
            }
            const m = msg as { type?: string; [k: string]: unknown };
            try {
                switch (m.type) {
                    case "setInstance": {
                        const overrides = isPartialPlayerOptions(m.overrides)
                            ? sanitize(m.overrides)
                            : {};
                        await setInstanceOverrides(
                            this.context,
                            document.uri,
                            overrides
                        );
                        postOptions();
                        return;
                    }
                    case "setGlobal": {
                        const patch = isPartialPlayerOptions(m.patch)
                            ? sanitize(m.patch)
                            : {};
                        await writeGlobalOptions(patch);
                        // onDidChangeConfiguration will trigger postOptions,
                        // but post immediately too in case the change event
                        // is debounced.
                        postOptions();
                        return;
                    }
                    case "resetGlobalKey": {
                        const key = m.key;
                        if (typeof key !== "string") {
                            return;
                        }
                        const patch: PartialPlayerOptions = {};
                        // Writing the schema default removes the override
                        // (writeGlobalOptions strips defaults).
                        (patch as Record<string, unknown>)[key] = (
                            DEFAULT_PLAYER_OPTIONS as unknown as Record<
                                string,
                                unknown
                            >
                        )[key];
                        await writeGlobalOptions(patch);
                        postOptions();
                        return;
                    }
                    case "promoteInstanceToGlobal": {
                        const instance = getInstanceOverrides(
                            this.context,
                            document.uri
                        );
                        await writeGlobalOptions(instance);
                        await setInstanceOverrides(
                            this.context,
                            document.uri,
                            {}
                        );
                        postOptions();
                        return;
                    }
                    case "openSettings": {
                        await vscode.commands.executeCommand(
                            "workbench.action.openSettings",
                            "asciinema.player"
                        );
                        return;
                    }
                }
            } catch (err) {
                console.error("[asciinema] webview message failed:", err);
            }
        });

        // ─── Host → Webview on global config change ──────────────────
        const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
            if (isPlayerConfigChange(e)) {
                postOptions();
            }
        });

        // Watch for file changes on disk and reload the webview
        const folder = vscode.Uri.joinPath(document.uri, "..");
        const fileName = document.uri.path.split("/").pop() ?? "*.cast";
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, fileName)
        );

        const reload = async (): Promise<void> => {
            const raw = await vscode.workspace.fs.readFile(document.uri);
            const content = new TextDecoder("utf-8").decode(raw);
            webview.html = getWebviewHtml({
                webview,
                playerJsUri,
                playerCssUri,
                castContent: content,
                resolution: buildResolution(),
            });
        };

        watcher.onDidChange(reload);
        webviewPanel.onDidDispose(() => {
            watcher.dispose();
            msgSub.dispose();
            cfgSub.dispose();
        });
    }
}
