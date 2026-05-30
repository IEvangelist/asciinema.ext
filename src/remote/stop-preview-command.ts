import * as vscode from "vscode";
import { showQuickPick } from "./artifact-handlers/quickpick.js";
import { previewRegistry, type ActivePreview } from "./preview-registry.js";

interface PreviewQuickPickItem extends vscode.QuickPickItem {
    readonly action: "stop-one" | "stop-all" | "noop";
    readonly preview?: ActivePreview;
}

/**
 * Implementation of `asciinema.stopHtmlPreview`.
 *
 * Always uses a QuickPick step so the flow stays in the command palette:
 * zero previews → no-op item, one preview → stop/keep options, multiple
 * previews → Stop all + one row per preview.
 */
export async function stopHtmlPreviewCommand(): Promise<void> {
    const previews = previewRegistry.list();

    const picked = await showQuickPick(buildStopPreviewItems(previews), {
        title: "GitHub Artifacts — Stop HTML preview",
        placeholder: stopPreviewPlaceholder(previews.length),
        step: 1,
        totalSteps: 1,
    });
    if (!picked || picked.action === "noop") {
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

function buildStopPreviewItems(
    previews: readonly ActivePreview[]
): PreviewQuickPickItem[] {
    if (previews.length === 0) {
        return [
            {
                label: "$(circle-slash)  No HTML previews running",
                description: "Nothing to stop",
                detail:
                    "Start an HTML preview from a GitHub artifact, then run this command to stop it.",
                action: "noop",
            },
        ];
    }

    if (previews.length === 1) {
        const only = previews[0];
        return [
            {
                label: "$(debug-stop)  Stop HTML preview",
                description: only.artifactName,
                detail: `${only.url} · started ${formatAge(only.startedAt)}`,
                action: "stop-one",
                preview: only,
            },
            {
                label: "$(debug-continue)  Keep preview running",
                description: "No changes",
                detail: "Dismisses this picker without stopping the server.",
                action: "noop",
            },
        ];
    }

    return [
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
}

function stopPreviewPlaceholder(previewCount: number): string {
    if (previewCount === 0) {
        return "No HTML previews are currently running";
    }
    if (previewCount === 1) {
        return "Press Enter to stop the preview, or pick Keep preview running";
    }
    return "Pick a preview to stop, or pick Stop all";
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
