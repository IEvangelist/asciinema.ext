import * as vscode from "vscode";

/**
 * Parses the asciicast header (first line of NDJSON) for display metadata.
 */
function parseCastHeader(castContent: string): Record<string, unknown> {
    try {
        const firstLine = castContent.split("\n")[0];
        return JSON.parse(firstLine);
    } catch {
        return {};
    }
}

/**
 * Formats a unix timestamp to a readable locale date string.
 */
function formatTimestamp(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/**
 * Detects the maximum number of terminal rows actually used by the recording.
 *
 * Simulates cursor-row tracking through all output ("o") events, handling:
 *   \n          – moves cursor down one row
 *   ESC[H / ESC[row;colH  – absolute cursor positioning
 *   ESC[nA / ESC[nB       – relative cursor up / down
 *   ESC[2J / ESC[3J       – full screen clear (resets cursor to row 0)
 *
 * Returns the header height when scrolling is detected (content exceeds
 * the recorded terminal height), or a tighter row count (with small
 * padding) when the content never fills the terminal.
 */
function detectMaxRows(castContent: string): number | undefined {
    const lines = castContent.trimEnd().split("\n");
    if (lines.length < 2) {
        return undefined;
    }

    let headerHeight: number | undefined;
    try {
        const header = JSON.parse(lines[0]);
        headerHeight = header.height;
    } catch {
        return undefined;
    }

    if (!headerHeight || headerHeight <= 0) {
        return undefined;
    }

    let cursorRow = 0;
    let maxRow = 0;

    for (let i = 1; i < lines.length; i++) {
        try {
            const event = JSON.parse(lines[i]);
            if (!Array.isArray(event) || event[1] !== "o") {
                continue;
            }

            const data: string = event[2];
            let j = 0;
            while (j < data.length) {
                if (data[j] === "\n") {
                    cursorRow++;
                    if (cursorRow >= headerHeight) {
                        // Terminal would scroll – full height is in use
                        return headerHeight;
                    }
                    maxRow = Math.max(maxRow, cursorRow);
                    j++;
                } else if (
                    data[j] === "\x1b" &&
                    j + 1 < data.length &&
                    data[j + 1] === "["
                ) {
                    // Parse CSI escape sequence: ESC [ <params> <command>
                    j += 2;
                    let params = "";
                    while (
                        j < data.length &&
                        ((data[j] >= "0" && data[j] <= "9") || data[j] === ";")
                    ) {
                        params += data[j];
                        j++;
                    }
                    if (j < data.length) {
                        const cmd = data[j];
                        j++;
                        if (cmd === "H" || cmd === "f") {
                            // CUP – Cursor Position  ESC[row;colH
                            const parts = params.split(";");
                            const row = parts[0]
                                ? parseInt(parts[0], 10) - 1
                                : 0;
                            cursorRow = Math.min(
                                Math.max(0, row),
                                headerHeight - 1
                            );
                            maxRow = Math.max(maxRow, cursorRow);
                        } else if (cmd === "A") {
                            // CUU – Cursor Up
                            const n = params ? parseInt(params, 10) : 1;
                            cursorRow = Math.max(0, cursorRow - n);
                        } else if (cmd === "B") {
                            // CUD – Cursor Down
                            const n = params ? parseInt(params, 10) : 1;
                            cursorRow = Math.min(
                                headerHeight - 1,
                                cursorRow + n
                            );
                            maxRow = Math.max(maxRow, cursorRow);
                        } else if (cmd === "J") {
                            // ED – Erase in Display (full clear resets cursor)
                            const n = params ? parseInt(params, 10) : 0;
                            if (n === 2 || n === 3) {
                                cursorRow = 0;
                            }
                        }
                    }
                } else {
                    j++;
                }
            }
        } catch {
            continue;
        }
    }

    // maxRow is 0-indexed, so +1 for count, +1 for a comfort line
    const detectedRows = Math.max(2, maxRow + 2);
    return Math.min(detectedRows, headerHeight);
}

/**
 * Computes approximate duration from the last event in the cast file.
 */
function computeDuration(castContent: string): number | undefined {
    const lines = castContent.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 1; i--) {
        try {
            const event = JSON.parse(lines[i]);
            if (Array.isArray(event) && typeof event[0] === "number") {
                return event[0];
            }
        } catch {
            continue;
        }
    }
    return undefined;
}

/**
 * Formats seconds into m:ss or h:mm:ss.
 */
function formatDuration(seconds: number): string {
    const s = Math.round(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Generates the complete HTML document for the asciinema player webview.
 */
export function getWebviewHtml(
    webview: vscode.Webview,
    playerJsUri: vscode.Uri,
    playerCssUri: vscode.Uri,
    castContent: string
): string {
    const nonce = getNonce();

    // Base64-encode the cast content and pass it as a data: URL —
    // this is the documented way to inline recordings without a fetch.
    const base64 = Buffer.from(castContent, "utf-8").toString("base64");
    const dataUrl = `data:text/plain;base64,${base64}`;

    // Extract metadata from the cast header
    const header = parseCastHeader(castContent);
    const title = header.title as string | undefined;
    const width = header.width as number | undefined;
    const height = header.height as number | undefined;
    const version = header.version as number | undefined;
    const timestamp = header.timestamp as number | undefined;
    const env = header.env as Record<string, string> | undefined;
    const shell = env?.SHELL;
    const term = env?.TERM;
    const rows = detectMaxRows(castContent);
    const duration =
        (header.duration as number | undefined) ?? computeDuration(castContent);

    // Build metadata items
    const metaItems: string[] = [];
    if (title) {
        metaItems.push(`<span class="meta-item" data-tooltip="Title: ${escapeHtml(title)}"><strong>${escapeHtml(title)}</strong></span>`);
    }
    if (duration !== undefined) {
        metaItems.push(`<span class="meta-item" data-tooltip="Duration: ${formatDuration(duration)}">&#9201;&#65039; ${formatDuration(duration)}</span>`);
    }
    if (width && height) {
        metaItems.push(`<span class="meta-item" data-tooltip="Terminal size: ${width}x${height}">&#128208; ${width}&times;${height}</span>`);
    }
    if (version) {
        metaItems.push(`<span class="meta-item" data-tooltip="Asciicast version: ${version}">&#128230; v${version}</span>`);
    }
    if (shell) {
        metaItems.push(`<span class="meta-item" data-tooltip="Shell: ${escapeHtml(shell)}">&#129299; ${escapeHtml(shell)}</span>`);
    }
    if (term) {
        metaItems.push(`<span class="meta-item" data-tooltip="Terminal type: ${escapeHtml(term)}">&#128187; ${escapeHtml(term)}</span>`);
    }
    if (timestamp) {
        metaItems.push(`<span class="meta-item" data-tooltip="Recorded on: ${formatTimestamp(timestamp)}">&#128197; ${formatTimestamp(timestamp)}</span>`);
    }

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';
        font-src ${webview.cspSource};
        worker-src blob:;
        connect-src data:;
        img-src ${webview.cspSource} data:;
    ">
    <link rel="stylesheet" href="${playerCssUri}">
    <title>Asciinema Player</title>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow-y: auto;
            overflow-x: hidden;
            background-color: var(--vscode-editor-background, #1e1e1e);
        }
        .wrapper {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        #player-container {
            flex: 1 1 auto;
            min-height: 200px;
            margin: 16px;
        }
        /* Fullscreen is not supported inside VS Code webviews */
        .ap-fullscreen-button {
            display: none !important;
        }
        .info-bar {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            gap: 16px;
            border-top: 1px solid var(--vscode-panel-border, #333);
            font-family: 'Cascadia Code', 'Fira Code', 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: 0.85em;
            letter-spacing: 0.02em;
            color: var(--vscode-descriptionForeground, #999);
        }
        .meta-items {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
        }
        .meta-item {
            position: relative;
            white-space: nowrap;
            background: color-mix(in srgb, var(--vscode-foreground, #ccc) 10%, transparent);
            color: var(--vscode-foreground, #ccc);
            padding: 3px 7px;
            border-radius: 12px;
            font-size: 0.82em;
            cursor: default;
        }
        .meta-item[data-tooltip]::before,
        .meta-item[data-tooltip]::after {
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.15s ease, transform 0.15s ease;
            z-index: 10;
        }
        .meta-item[data-tooltip]::before {
            content: attr(data-tooltip);
            bottom: calc(100% + 8px);
            background: var(--vscode-editorHoverWidget-background, #2d2d30);
            color: var(--vscode-editorHoverWidget-foreground, #ccc);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            padding: 5px 12px;
            border-radius: 6px;
            font-size: 0.95em;
            white-space: nowrap;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .meta-item[data-tooltip]::after {
            content: '';
            bottom: calc(100% + 3px);
            border: 6px solid transparent;
            border-top: 6px solid var(--vscode-editorHoverWidget-background, #2d2d30);
        }
        .meta-item[data-tooltip]:hover::before,
        .meta-item[data-tooltip]:hover::after {
            opacity: 1;
        }
        .meta-sep {
            display: none;
        }
        .meta-toggle {
            cursor: pointer;
            font-size: 0.75em;
            padding: 3px 5px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: none;
            outline: none;
        }
        .toggle-icon {
            width: 14px;
            height: 14px;
            transition: transform 0.2s ease;
        }
        .meta-items.collapsed .toggle-icon {
            transform: rotate(180deg);
        }
        .meta-items.collapsed .meta-item:not(.meta-toggle),
        .meta-items.collapsed .meta-sep {
            display: none;
        }
        .asciinema-link {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            color: var(--vscode-descriptionForeground, #999);
            text-decoration: none;
            white-space: nowrap;
            font-weight: 500;
            transition: color 0.15s ease;
        }
        .asciinema-link:hover {
            color: var(--vscode-foreground, #eee);
        }
        .asciinema-link svg {
            width: 18px;
            height: 18px;
        }
        .info-bar-right {
            display: flex;
            align-items: center;
            gap: 14px;
        }
        .theme-picker {
            position: relative;
        }
        .theme-picker-btn {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            background: color-mix(in srgb, var(--vscode-foreground, #ccc) 10%, transparent);
            color: var(--vscode-descriptionForeground, #999);
            border: 1px solid transparent;
            padding: 3px 7px;
            border-radius: 12px;
            font-size: 0.92em;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            transition: color 0.15s ease, border-color 0.15s ease;
        }
        .theme-picker-btn:hover {
            color: var(--vscode-foreground, #eee);
            border-color: var(--vscode-panel-border, #555);
        }
        .theme-picker-btn svg {
            width: 12px;
            height: 12px;
            transition: transform 0.2s ease;
        }
        .theme-picker.open .theme-picker-btn svg {
            transform: rotate(180deg);
        }
        .theme-menu {
            display: none;
            position: absolute;
            bottom: calc(100% + 8px);
            right: 0;
            min-width: 170px;
            background: var(--vscode-editorHoverWidget-background, #2d2d30);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
            padding: 4px 0;
            z-index: 100;
        }
        .theme-picker.open .theme-menu {
            display: block;
        }
        .theme-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 6px 14px;
            background: none;
            border: none;
            color: var(--vscode-foreground, #ccc);
            font-size: 0.92em;
            font-family: inherit;
            cursor: pointer;
            text-align: left;
            white-space: nowrap;
        }
        .theme-menu-item:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .theme-menu-item.active {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .theme-menu-item .check {
            width: 14px;
            text-align: center;
            font-size: 0.85em;
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <div id="player-container"></div>
        <div class="info-bar">
            <div class="meta-items" id="meta-items">
                ${metaItems.join('<span class="meta-sep">&middot;</span>')}
                <button class="meta-item meta-toggle" id="meta-toggle" type="button" data-tooltip="Collapse badges"><svg class="toggle-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M5.928 8.024l4.357-4.357-.618-.62L4.93 7.71a.444.444 0 000 .628l4.737 4.615.618-.62-4.357-4.31z"/></svg></button>
            </div>
            <div class="info-bar-right">
                <div class="theme-picker" id="theme-picker">
                    <button class="theme-picker-btn" id="theme-picker-btn" type="button">
                        &#127912; Theme
                        <svg viewBox="0 0 12 12" fill="currentColor"><path d="M2 4.5L6 8.5L10 4.5H2Z"/></svg>
                    </button>
                    <div class="theme-menu" id="theme-menu"></div>
                </div>
                <a class="asciinema-link" title="Powered by asciinema" href="https://asciinema.org">
                <svg viewBox="-130 -130 1126 1126" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <mask id="small-triangle-mask">
                            <rect width="100%" height="100%" fill="white"/>
                            <polygon points="508.01270189221935 433.01270189221935, 208.0127018922194 259.8076211353316, 208.01270189221927 606.217782649107" fill="black"></polygon>
                        </mask>
                    </defs>
                    <polygon points="808.0127018922194 433.01270189221935, 58.01270189221947 -1.1368683772161603e-13, 58.01270189221913 866.0254037844386" mask="url(#small-triangle-mask)" fill="#d40000"></polygon>
                    <polyline points="481.2177826491071 333.0127018922194, 134.80762113533166 533.0127018922194" stroke="#d40000" stroke-width="90"></polyline>
                </svg>
                Powered by asciinema
                </a>
            </div>
        </div>
    </div>
    <script nonce="${nonce}" src="${playerJsUri}"></script>
    <script nonce="${nonce}">
        (function() {
            try {
                const container = document.getElementById('player-container');
                let player = null;

                const allThemes = [
                    { id: 'asciinema', label: 'Asciinema' },
                    { id: 'dracula', label: 'Dracula' },
                    { id: 'monokai', label: 'Monokai' },
                    { id: 'nord', label: 'Nord' },
                    { id: 'solarized-dark', label: 'Solarized Dark' },
                    { id: 'solarized-light', label: 'Solarized Light' },
                    { id: 'tango', label: 'Tango' },
                ];

                let currentTheme = null;

                function getThemeForVSCode() {
                    const body = document.body;
                    if (body.classList.contains('vscode-light') ||
                        body.classList.contains('vscode-high-contrast-light')) {
                            return 'auto/dracula';
                        }
                        return 'auto/nord';
                }

                function getEffectiveTheme() {
                    return currentTheme || getThemeForVSCode();
                }

                function createPlayer() {
                    // Dispose the previous player instance
                    if (player) {
                        player.dispose();
                        container.innerHTML = '';
                    }
                    player = AsciinemaPlayer.create(
                        '${dataUrl}',
                        container,
                        {
                            fit: ${rows !== undefined && rows !== height ? '"width"' : '"both"'},
                            autoPlay: true,
                            terminalFontFamily: "'Cascadia Code', 'Fira Code', 'Menlo', 'Monaco', 'Courier New', monospace",
                            theme: getEffectiveTheme(),
                            ${rows !== undefined && rows !== height ? `rows: ${rows},` : ''}
                            logger: console
                        }
                    );
                }

                // Theme picker
                const picker = document.getElementById('theme-picker');
                const pickerBtn = document.getElementById('theme-picker-btn');
                const menu = document.getElementById('theme-menu');

                function renderThemeMenu() {
                    const effectiveTheme = getEffectiveTheme();
                    menu.innerHTML = allThemes.map(function(t) {
                        const isAuto = !currentTheme;
                        const autoTheme = getThemeForVSCode();
                        const isActive = currentTheme
                            ? effectiveTheme === t.id
                            : autoTheme.endsWith(t.id);
                        return '<button class="theme-menu-item' + (isActive ? ' active' : '') + '" data-theme="' + t.id + '">' +
                            '<span class="check">' + (isActive ? '✅' : '') + '</span>' +
                            t.label +
                            '</button>';
                    }).join('') +
                    '<button class="theme-menu-item' + (!currentTheme ? ' active' : '') + '" data-theme="auto">' +
                        '<span class="check">' + (!currentTheme ? '✅' : '') + '</span>' +
                        'Auto (VS Code)' +
                    '</button>';
                }

                renderThemeMenu();

                pickerBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    picker.classList.toggle('open');
                    renderThemeMenu();
                });

                menu.addEventListener('click', function(e) {
                    const btn = e.target.closest('[data-theme]');
                    if (!btn) return;
                    const theme = btn.getAttribute('data-theme');
                    if (theme === 'auto') {
                        currentTheme = null;
                    } else {
                        currentTheme = theme;
                    }
                    picker.classList.remove('open');
                    createPlayer();
                });

                document.addEventListener('click', function() {
                    picker.classList.remove('open');
                });

                // Collapse/expand toggle for badges
                const metaItemsEl = document.getElementById('meta-items');
                const metaToggle = document.getElementById('meta-toggle');
                metaToggle.addEventListener('click', function() {
                    const collapsed = metaItemsEl.classList.toggle('collapsed');
                    metaToggle.setAttribute('data-tooltip', collapsed ? 'Expand badges' : 'Collapse badges');
                });

                // Initial creation
                createPlayer();

                // Watch for VS Code theme changes via body class mutations
                const observer = new MutationObserver(function(mutations) {
                    for (const mutation of mutations) {
                        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                            if (!currentTheme) {
                                createPlayer();
                            }
                            break;
                        }
                    }
                });
                observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

            } catch (err) {
                document.body.innerHTML = '<pre style="color:#f44;padding:2em;">' +
                    'Failed to initialize asciinema player:\\n' + err + '</pre>';
            }
        })();
    </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function getNonce(): string {
    let text = "";
    const possible =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
