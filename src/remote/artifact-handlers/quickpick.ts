import * as vscode from "vscode";

export interface QuickPickShowOptions {
    readonly title: string;
    readonly placeholder: string;
    readonly step?: number;
    readonly totalSteps?: number;
    readonly buttons?: readonly vscode.QuickInputButton[];
    /** Invoked when any item button is triggered. */
    readonly onTriggerItemButton?: () => void;
}

/**
 * Thin wrapper around `createQuickPick` that returns the chosen item (or
 * `undefined` if the user dismissed). Always enables `matchOnDescription`,
 * `matchOnDetail`, and `ignoreFocusOut`.
 */
export function showQuickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: QuickPickShowOptions
): Promise<T | undefined> {
    return new Promise((resolve) => {
        const qp = vscode.window.createQuickPick<T>();
        let settled = false;
        const finish = (value: T | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        qp.title = options.title;
        qp.placeholder = options.placeholder;
        qp.step = options.step;
        qp.totalSteps = options.totalSteps;
        qp.items = items;
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.ignoreFocusOut = true;
        if (options.buttons) {
            qp.buttons = options.buttons;
        }
        if (options.onTriggerItemButton) {
            qp.onDidTriggerItemButton(() => options.onTriggerItemButton!());
        }
        qp.onDidAccept(() => {
            const selection = qp.selectedItems[0];
            finish(selection);
            qp.hide();
        });
        qp.onDidHide(() => {
            qp.dispose();
            finish(undefined);
        });
        qp.show();
    });
}
