import * as vscode from "vscode";

/**
 * A live static-site preview tracked by {@link previewRegistry}.
 *
 * Each entry owns its server, terminal, and JSZip instance via
 * `dispose()`. Disposal is the single chokepoint everything funnels
 * through — Ctrl+C inside the pty, the Stop HTML preview command, the
 * status bar click, and `deactivate` all call it. The registry's
 * `unregister` is invoked from the pseudoterminal's `close` callback so
 * external dispose paths (e.g. the user pressing the trash can on the
 * terminal tab) keep the registry in sync.
 */
export interface ActivePreview {
    readonly id: string;
    readonly artifactName: string;
    readonly url: string;
    readonly startedAt: number;
    readonly dispose: () => Promise<void> | void;
}

class PreviewRegistry {
    private readonly entries = new Map<string, ActivePreview>();
    private readonly emitter = new vscode.EventEmitter<void>();

    readonly onDidChange = this.emitter.event;

    register(preview: ActivePreview): void {
        this.entries.set(preview.id, preview);
        this.emitter.fire();
    }

    unregister(id: string): void {
        if (this.entries.delete(id)) {
            this.emitter.fire();
        }
    }

    list(): readonly ActivePreview[] {
        return [...this.entries.values()].sort(
            (a, b) => a.startedAt - b.startedAt
        );
    }

    /**
     * Disposes every active preview and clears the registry. Returns once
     * all underlying servers have closed. Used by the "Stop all" QuickPick
     * row and by `deactivate`.
     */
    async stopAll(): Promise<void> {
        const all = [...this.entries.values()];
        this.entries.clear();
        this.emitter.fire();
        await Promise.all(
            all.map(async (p) => {
                try {
                    await p.dispose();
                } catch {
                    // best-effort — one failed dispose can't block the rest
                }
            })
        );
    }

    /** Test-only hook: drops state without disposing anything. */
    _resetForTests(): void {
        this.entries.clear();
        this.emitter.fire();
    }
}

export const previewRegistry = new PreviewRegistry();
