import * as vscode from "vscode";
import { previewRegistry, type ActivePreview } from "./preview-registry.js";

interface PreviewQuickPickItem extends vscode.QuickPickItem {
    readonly action: "stop-one" | "stop-all";
    readonly preview?: ActivePreview;
}

/**
 * Implementation of `asciinema.stopHtmlPreview`.
 *
 * Zero previews → info toast.
 * One preview → confirm + stop straight away.
 * 2+ previews → QuickPick with `$(close-all)  Stop all` + one row per preview.
 */
export async function stopHtmlPreviewCommand(): Promise<void> {
    const previews = previewRegistry.list();
    if (previews.length === 0) {
        await vscode.window.showInformationMessage(
            "No HTML previews are currently running."
        );
        return;
    }

    if (previews.length === 1) {
        const only = previews[0];
        const confirm = await vscode.window.showWarningMessage(
            `Stop HTML preview for "${only.artifactName}" (${only.url})?`,
            { modal: false },
            "Stop"
        );
        if (confirm !== "Stop") {
            return;
        }
        await only.dispose();
        return;
    }

    const items: PreviewQuickPickItem[] = [
        {
            label: "$(close-all)  Stop all",
            description: `${previews.length} ${
                previews.length === 1 ? "preview" : "previews"
            }`,
            detail: "Disposes every running static-site preview",
            action: "stop-all",
        },
        {
            label: "Active previews",
            kind: vscode.QuickPickItemKind.Separator,
            action: "stop-one",
        },
        ...previews.map<PreviewQuickPickItem>((p) => ({
            label: `$(debug-stop)  ${p.artifactName}`,
            description: `${p.url} · started ${formatAge(p.startedAt)}`,
            detail: `Preview id ${p.id}`,
            action: "stop-one",
            preview: p,
        })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: "Asciinema — Stop HTML preview",
        placeHolder: "Pick a preview to stop, or pick Stop all…",
        ignoreFocusOut: true,
    });
    if (!picked) {
        return;
    }
    if (picked.action === "stop-all") {
        await previewRegistry.stopAll();
        return;
    }
    if (picked.preview) {
        await picked.preview.dispose();
    }
}

/**
 * Creates the right-side status bar item that's visible while any
 * HTML preview is running. Click → `asciinema.stopHtmlPreview`.
 *
 * Returns a `Disposable` that owns the item and the registry subscription.
 */
export function createPreviewStatusBarItem(): vscode.Disposable {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    item.command = "asciinema.stopHtmlPreview";

    const refresh = (): void => {
        const previews = previewRegistry.list();
        if (previews.length === 0) {
            item.hide();
            return;
        }
        if (previews.length === 1) {
            const only = previews[0];
            item.text = `$(debug-stop) HTML preview`;
            item.tooltip = `Click to stop: ${only.artifactName} (${only.url})`;
        } else {
            item.text = `$(debug-stop) HTML previews (${previews.length})`;
            item.tooltip = "Click to pick which preview to stop";
        }
        item.show();
    };

    refresh();
    const sub = previewRegistry.onDidChange(() => refresh());

    return {
        dispose: () => {
            sub.dispose();
            item.dispose();
        },
    };
}

function formatAge(startedAt: number): string {
    const ms = Date.now() - startedAt;
    if (ms < 0) {
        return "just now";
    }
    const sec = Math.floor(ms / 1000);
    if (sec < 60) {
        return `${sec}s ago`;
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min}m ago`;
    }
    const hr = Math.floor(min / 60);
    if (hr < 24) {
        return `${hr}h ago`;
    }
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
}
