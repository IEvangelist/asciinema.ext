import * as vscode from "vscode";

/**
 * Represents a .cast file opened in the custom readonly editor.
 */
export class CastDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;
    private _content: string;

    private constructor(uri: vscode.Uri, content: string) {
        this.uri = uri;
        this._content = content;
    }

    /**
     * Creates a new CastDocument by reading the .cast file from disk.
     */
    static async create(uri: vscode.Uri): Promise<CastDocument> {
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder("utf-8").decode(raw);
        return new CastDocument(uri, content);
    }

    /**
     * The raw text content of the .cast file (NDJSON).
     */
    get content(): string {
        return this._content;
    }

    dispose(): void {
        // Nothing to dispose
    }
}
