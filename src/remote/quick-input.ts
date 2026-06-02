import * as vscode from "vscode";

export interface PaletteAction<T extends string> extends vscode.QuickPickItem {
    readonly value: T;
}

export interface PickPaletteActionOptions {
    readonly title: string;
    readonly message: string;
    readonly placeholder?: string;
    readonly step?: number;
    readonly totalSteps?: number;
}

interface PaletteActionItem<T extends string> extends vscode.QuickPickItem {
    readonly value?: T;
}

export async function pickPaletteAction<T extends string>(
    actions: readonly PaletteAction<T>[],
    options: PickPaletteActionOptions
): Promise<T | undefined> {
    const items: PaletteActionItem<T>[] = [
        {
            label: options.message,
            kind: vscode.QuickPickItemKind.Separator,
        },
        ...actions,
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: options.title,
        placeHolder: options.placeholder ?? options.message,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return picked?.value;
}

export async function showPaletteNotice(
    title: string,
    message: string,
    severity: "info" | "warning" | "error" = "info"
): Promise<void> {
    const icon =
        severity === "error"
            ? "$(error)"
            : severity === "warning"
              ? "$(warning)"
              : "$(info)";
    await pickPaletteAction(
        [
            {
                label: `${icon}  Dismiss`,
                description: message,
                value: "dismiss",
            },
        ],
        { title, message }
    );
}

export async function confirmPalette(
    title: string,
    message: string,
    confirmLabel: string,
    detail?: string
): Promise<boolean> {
    const picked = await pickPaletteAction(
        [
            {
                label: `$(check)  ${confirmLabel}`,
                detail,
                value: "confirm",
            },
            {
                label: "$(close)  Cancel",
                value: "cancel",
            },
        ],
        { title, message }
    );
    return picked === "confirm";
}

export interface PaletteProgressOptions {
    readonly title: string;
    readonly placeholder: string;
    readonly initialMessage?: string;
    readonly cancellable?: boolean;
    readonly step?: number;
    readonly totalSteps?: number;
}

export interface PaletteProgressReport {
    readonly message?: string;
    readonly increment?: number;
}

interface PaletteProgressItem extends vscode.QuickPickItem {
    readonly action?: "cancel";
}

export async function withPaletteProgress<T>(
    options: PaletteProgressOptions,
    task: (
        progress: vscode.Progress<PaletteProgressReport>,
        token: vscode.CancellationToken
    ) => PromiseLike<T> | T
): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const qp = vscode.window.createQuickPick<PaletteProgressItem>();
        const cts = new vscode.CancellationTokenSource();
        let disposed = false;
        let settled = false;
        let message = options.initialMessage ?? options.placeholder;

        const setItems = () => {
            if (disposed) {
                return;
            }
            const statusLabel = cts.token.isCancellationRequested
                ? "$(sync~spin)  Cancelling..."
                : "$(sync~spin)  Working...";
            const items: PaletteProgressItem[] = [
                {
                    label: statusLabel,
                    description: message,
                },
            ];
            if (options.cancellable) {
                items.push({
                    label: "$(circle-slash)  Cancel",
                    description: "Stop this operation",
                    action: "cancel",
                });
            }
            qp.items = items;
        };

        qp.title = options.title;
        qp.placeholder = options.placeholder;
        qp.step = options.step;
        qp.totalSteps = options.totalSteps;
        qp.busy = true;
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.ignoreFocusOut = true;
        setItems();

        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            if (picked?.action === "cancel" && options.cancellable) {
                cts.cancel();
                setItems();
            }
        });
        qp.onDidHide(() => {
            disposed = true;
            qp.dispose();
            if (!settled && options.cancellable && !cts.token.isCancellationRequested) {
                cts.cancel();
            }
        });

        const progress: vscode.Progress<PaletteProgressReport> = {
            report: (value) => {
                if (value.message) {
                    message = value.message;
                    setItems();
                }
            },
        };
        const complete = (callback: () => void) => {
            settled = true;
            if (!disposed) {
                qp.hide();
            }
            cts.dispose();
            callback();
        };

        qp.show();
        void Promise.resolve()
            .then(() => task(progress, cts.token))
            .then(
                (value) => {
                    complete(() => resolve(value));
                },
                (err) => {
                    complete(() => reject(err));
                }
            );
    });
}
