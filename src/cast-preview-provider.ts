import * as vscode from "vscode";
import { CastDocument } from "./cast-document.js";
import { getWebviewHtml } from "./webview-html.js";

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

        webview.html = getWebviewHtml(
            webview,
            playerJsUri,
            playerCssUri,
            document.content
        );

        // Watch for file changes on disk and reload the webview
        const folder = vscode.Uri.joinPath(document.uri, "..");
        const fileName = document.uri.path.split("/").pop() ?? "*.cast";
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, fileName)
        );

        const reload = async () => {
            const raw = await vscode.workspace.fs.readFile(document.uri);
            const content = new TextDecoder("utf-8").decode(raw);
            webview.html = getWebviewHtml(
                webview,
                playerJsUri,
                playerCssUri,
                content
            );
        };

        watcher.onDidChange(reload);
        webviewPanel.onDidDispose(() => watcher.dispose());
    }
}
