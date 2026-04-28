import * as vscode from "vscode";
import {
    DEFAULT_PLAYER_OPTIONS,
    PLAYER_OPTION_KEYS,
    THEME_CHOICES,
    toPlayerCreateOptions,
    type MergedResolution,
    type PartialPlayerOptions,
    type PlayerOptions,
} from "./player-options.js";

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
 * Returns the header height when content scrolls, or a tighter row count
 * (with small padding) when content never fills the terminal.
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
                        return headerHeight;
                    }
                    maxRow = Math.max(maxRow, cursorRow);
                    j++;
                } else if (
                    data[j] === "\x1b" &&
                    j + 1 < data.length &&
                    data[j + 1] === "["
                ) {
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
                            const n = params ? parseInt(params, 10) : 1;
                            cursorRow = Math.max(0, cursorRow - n);
                        } else if (cmd === "B") {
                            const n = params ? parseInt(params, 10) : 1;
                            cursorRow = Math.min(
                                headerHeight - 1,
                                cursorRow + n
                            );
                            maxRow = Math.max(maxRow, cursorRow);
                        } else if (cmd === "J") {
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
    const detectedRows = Math.max(2, maxRow + 2);
    return Math.min(detectedRows, headerHeight);
}

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

export interface WebviewBuildContext {
    readonly webview: vscode.Webview;
    readonly playerJsUri: vscode.Uri;
    readonly playerCssUri: vscode.Uri;
    readonly castContent: string;
    readonly resolution: MergedResolution;
}

/**
 * Generates the complete HTML document for the asciinema player webview,
 * including the settings cog flyout for per-cast & global option editing.
 */
export function getWebviewHtml(ctx: WebviewBuildContext): string {
    const { webview, playerJsUri, playerCssUri, castContent, resolution } = ctx;
    const nonce = getNonce();

    const base64 = Buffer.from(castContent, "utf-8").toString("base64");
    const dataUrl = `data:text/plain;base64,${base64}`;

    const header = parseCastHeader(castContent);
    const title = header.title as string | undefined;
    const width = header.width as number | undefined;
    const height = header.height as number | undefined;
    const version = header.version as number | undefined;
    const timestamp = header.timestamp as number | undefined;
    const env = header.env as Record<string, string> | undefined;
    const shell = env?.SHELL;
    const term = env?.TERM;
    const detectedRows = detectMaxRows(castContent);
    const duration =
        (header.duration as number | undefined) ?? computeDuration(castContent);

    // If the user hasn't explicitly chosen `fit`, downsize a sparse recording
    // to its detected row count to match prior behavior.
    const shouldUseDetectedRows =
        detectedRows !== undefined &&
        detectedRows !== height &&
        resolution.source.fit === "default";
    const rowsOverride = shouldUseDetectedRows ? detectedRows : undefined;

    const metaItems: string[] = [];
    if (title) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Title: ${escapeHtml(title)}"><strong>${escapeHtml(title)}</strong></span>`
        );
    }
    if (duration !== undefined) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Duration: ${formatDuration(duration)}">&#9201;&#65039; ${formatDuration(duration)}</span>`
        );
    }
    if (width && height) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Terminal size: ${width}x${height}">&#128208; ${width}&times;${height}</span>`
        );
    }
    if (version) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Asciicast version: ${version}">&#128230; v${version}</span>`
        );
    }
    if (shell) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Shell: ${escapeHtml(shell)}">&#129299; ${escapeHtml(shell)}</span>`
        );
    }
    if (term) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Terminal type: ${escapeHtml(term)}">&#128187; ${escapeHtml(term)}</span>`
        );
    }
    if (timestamp) {
        metaItems.push(
            `<span class="meta-item" data-tooltip="Recorded on: ${formatTimestamp(timestamp)}">&#128197; ${formatTimestamp(timestamp)}</span>`
        );
    }

    const initialState = JSON.stringify({
        defaults: resolution.defaults,
        global: resolution.global,
        instance: resolution.instance,
        merged: resolution.merged,
        source: resolution.source,
        rowsOverride,
        themeChoices: THEME_CHOICES,
        keys: PLAYER_OPTION_KEYS,
    });

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
        .wrapper { display: flex; flex-direction: column; height: 100vh; }
        #player-container { flex: 1 1 auto; min-height: 200px; margin: 16px; }
        .ap-fullscreen-button { display: none !important; }
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
        .meta-items { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
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
            position: absolute; left: 50%; transform: translateX(-50%);
            pointer-events: none; opacity: 0;
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
        .meta-item[data-tooltip]:hover::after { opacity: 1; }
        .meta-sep { display: none; }
        .meta-toggle {
            cursor: pointer; font-size: 0.75em; padding: 3px 5px;
            line-height: 1; display: inline-flex; align-items: center;
            justify-content: center; border: none; outline: none;
        }
        .toggle-icon { width: 14px; height: 14px; transition: transform 0.2s ease; }
        .meta-items.collapsed .toggle-icon { transform: rotate(180deg); }
        .meta-items.collapsed .meta-item:not(.meta-toggle),
        .meta-items.collapsed .meta-sep { display: none; }
        .asciinema-link {
            display: inline-flex; align-items: center; gap: 7px;
            color: var(--vscode-descriptionForeground, #999);
            text-decoration: none; white-space: nowrap;
            font-weight: 500; transition: color 0.15s ease;
        }
        .asciinema-link:hover { color: var(--vscode-foreground, #eee); }
        .asciinema-link svg { width: 18px; height: 18px; }
        .info-bar-right { display: flex; align-items: center; gap: 14px; }

        /* Settings cog button */
        .settings-cog {
            position: relative;
        }
        .cog-btn {
            display: inline-flex; align-items: center; gap: 5px;
            background: color-mix(in srgb, var(--vscode-foreground, #ccc) 10%, transparent);
            color: var(--vscode-descriptionForeground, #999);
            border: 1px solid transparent;
            padding: 4px 9px; border-radius: 12px;
            font-size: 0.92em; font-family: inherit;
            cursor: pointer; white-space: nowrap;
            transition: color 0.15s ease, border-color 0.15s ease;
        }
        .cog-btn:hover {
            color: var(--vscode-foreground, #eee);
            border-color: var(--vscode-panel-border, #555);
        }
        .cog-btn svg { width: 14px; height: 14px; }

        /* Settings flyout */
        .cog-panel {
            display: none;
            position: absolute;
            bottom: calc(100% + 10px);
            right: 0;
            width: 380px;
            max-height: 70vh;
            overflow-y: auto;
            background: var(--vscode-editorHoverWidget-background, #2d2d30);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            border-radius: 8px;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
            padding: 14px 16px 12px;
            z-index: 1000;
            font-family: var(--vscode-font-family, system-ui, sans-serif);
            font-size: 13px;
            color: var(--vscode-foreground, #ddd);
        }
        .settings-cog.open .cog-panel { display: block; }
        .cog-panel .panel-header {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 10px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
        }
        .cog-panel .panel-title {
            font-weight: 600; font-size: 13px;
        }
        .panel-close {
            background: none; border: none; color: var(--vscode-descriptionForeground, #999);
            cursor: pointer; font-size: 16px; line-height: 1;
            padding: 2px 6px;
        }
        .panel-close:hover { color: var(--vscode-foreground, #fff); }
        .scope-tabs {
            display: flex; gap: 4px;
            margin-bottom: 12px;
            background: color-mix(in srgb, var(--vscode-foreground, #ccc) 6%, transparent);
            border-radius: 6px;
            padding: 3px;
        }
        .scope-tab {
            flex: 1;
            background: none; border: none;
            color: var(--vscode-descriptionForeground, #999);
            padding: 6px 8px; border-radius: 4px;
            font-size: 12px; font-family: inherit;
            cursor: pointer;
        }
        .scope-tab.active {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #fff);
        }
        .group-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--vscode-descriptionForeground, #999);
            margin: 12px 0 6px;
            font-weight: 600;
        }
        .opt-row {
            display: grid;
            grid-template-columns: 130px 1fr auto;
            gap: 8px;
            align-items: center;
            padding: 5px 0;
        }
        .opt-row label { font-size: 12px; color: var(--vscode-foreground, #ddd); }
        .opt-row input[type="text"],
        .opt-row input[type="number"],
        .opt-row select {
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #ddd);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            padding: 3px 6px;
            font-size: 12px;
            font-family: inherit;
            width: 100%;
            box-sizing: border-box;
        }
        .opt-row input[type="checkbox"] { margin: 0; }
        .opt-source {
            font-size: 10px;
            color: var(--vscode-descriptionForeground, #888);
            white-space: nowrap;
        }
        .opt-source.s-instance { color: #4ec9b0; }
        .opt-source.s-global   { color: #569cd6; }
        .opt-source.s-default  { color: #888; }
        .reset-btn {
            background: none; border: none;
            color: var(--vscode-descriptionForeground, #888);
            cursor: pointer; padding: 0 4px;
            font-size: 13px;
        }
        .reset-btn:hover { color: var(--vscode-foreground, #fff); }
        .reset-btn[disabled] { opacity: 0.25; cursor: default; }
        .panel-actions {
            display: flex; flex-direction: column; gap: 6px;
            margin-top: 14px;
            padding-top: 10px;
            border-top: 1px solid var(--vscode-panel-border, #444);
        }
        .panel-actions button {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #fff);
            border: none; border-radius: 3px;
            padding: 6px 10px; font-size: 12px; font-family: inherit;
            cursor: pointer;
        }
        .panel-actions button.secondary {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
        }
        .panel-actions button:hover { filter: brightness(1.15); }
        .panel-actions a {
            color: var(--vscode-textLink-foreground, #3794ff);
            font-size: 12px; text-decoration: none;
            text-align: center; padding: 4px;
        }
        .panel-actions a:hover { text-decoration: underline; }
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
                <div class="settings-cog" id="settings-cog">
                    <button class="cog-btn" id="cog-btn" type="button" title="Player settings">
                        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>
                        Settings
                    </button>
                    <div class="cog-panel" id="cog-panel"></div>
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
        const vscodeApi = acquireVsCodeApi();
        const dataUrl = ${JSON.stringify(dataUrl)};
        let state = ${initialState};
        let player = null;
        const container = document.getElementById('player-container');

        // ─── Option groups & metadata ─────────────────────────────────
        const GROUPS = [
            { title: 'Playback', keys: ['autoPlay','preload','loop','startAt','speed','idleTimeLimit','pauseOnMarkers'] },
            { title: 'Appearance', keys: ['theme','fit','controls','terminalFontSize','terminalFontFamily','terminalLineHeight'] },
            { title: 'Other', keys: ['poster'] },
        ];
        const META = {
            autoPlay:           { label: 'Autoplay', kind: 'bool' },
            preload:            { label: 'Preload',  kind: 'bool' },
            loop:               { label: 'Loop',     kind: 'loop' },
            startAt:            { label: 'Start at', kind: 'startAt' },
            speed:              { label: 'Speed',    kind: 'number', step: 0.1, min: 0.1 },
            idleTimeLimit:      { label: 'Idle time limit (s)', kind: 'idle' },
            pauseOnMarkers:     { label: 'Pause on markers', kind: 'bool' },
            theme:              { label: 'Theme',    kind: 'enum', choices: state.themeChoices },
            fit:                { label: 'Fit',      kind: 'enum', choices: ['width','height','both','none'] },
            controls:           { label: 'Controls', kind: 'enum', choices: ['auto','always','never'] },
            terminalFontSize:   { label: 'Font size', kind: 'fontSize' },
            terminalFontFamily: { label: 'Font family', kind: 'string' },
            terminalLineHeight: { label: 'Line height', kind: 'number', step: 0.05, min: 0.5 },
            poster:             { label: 'Poster', kind: 'string', placeholder: 'npt:1:23 or data:text/plain,...' },
        };

        // ─── Auto theme based on VS Code ──────────────────────────────
        function autoTheme() {
            const body = document.body;
            if (body.classList.contains('vscode-light') ||
                body.classList.contains('vscode-high-contrast-light')) {
                return 'auto/dracula';
            }
            return 'auto/nord';
        }

        // ─── Effective options for AsciinemaPlayer.create ─────────────
        function buildPlayerOpts() {
            const m = state.merged;
            const out = {
                autoPlay: m.autoPlay,
                preload: m.preload,
                loop: m.loop,
                startAt: m.startAt,
                speed: m.speed,
                pauseOnMarkers: m.pauseOnMarkers,
                terminalFontFamily: m.terminalFontFamily,
                terminalLineHeight: m.terminalLineHeight,
                logger: console,
            };
            if (m.idleTimeLimit !== null) out.idleTimeLimit = m.idleTimeLimit;
            out.fit = m.fit === 'none' ? false : m.fit;
            out.controls = m.controls === 'always' ? true : m.controls === 'never' ? false : 'auto';
            if (m.terminalFontSize) out.terminalFontSize = m.terminalFontSize;
            if (m.poster) out.poster = m.poster;
            out.theme = m.theme === 'auto' ? autoTheme() : m.theme;
            if (state.rowsOverride !== undefined && state.source.fit === 'default') out.rows = state.rowsOverride;
            return out;
        }

        function createPlayer() {
            if (player) {
                try { player.dispose(); } catch (_) {}
                container.innerHTML = '';
            }
            player = AsciinemaPlayer.create(dataUrl, container, buildPlayerOpts());
        }

        // ─── Settings flyout rendering ────────────────────────────────
        const cog = document.getElementById('settings-cog');
        const cogBtn = document.getElementById('cog-btn');
        const panel = document.getElementById('cog-panel');
        let scope = 'instance';

        cogBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (cog.classList.contains('open')) {
                cog.classList.remove('open');
            } else {
                renderPanel();
                cog.classList.add('open');
            }
        });
        document.addEventListener('click', function(e) {
            if (!cog.contains(e.target)) cog.classList.remove('open');
        });
        panel.addEventListener('click', function(e) { e.stopPropagation(); });

        function valueForScope(key) {
            if (scope === 'instance') {
                if (key in state.instance) return state.instance[key];
                if (key in state.global)   return state.global[key];
                return state.defaults[key];
            }
            if (key in state.global) return state.global[key];
            return state.defaults[key];
        }

        function sourceFor(key) {
            if (scope === 'instance') return state.source[key];
            return key in state.global ? 'global' : 'default';
        }

        function escapeHtmlClient(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function controlHtml(key, val) {
            const m = META[key];
            const id = 'opt-' + key;
            switch (m.kind) {
                case 'bool':
                    return '<input type="checkbox" id="' + id + '" data-key="' + key + '"' + (val ? ' checked' : '') + ' />';
                case 'enum': {
                    let html = '<select id="' + id + '" data-key="' + key + '">';
                    for (const c of m.choices) {
                        html += '<option value="' + escapeHtmlClient(c) + '"' + (val === c ? ' selected' : '') + '>' + escapeHtmlClient(c) + '</option>';
                    }
                    return html + '</select>';
                }
                case 'number':
                    return '<input type="number" id="' + id + '" data-key="' + key + '" step="' + m.step + '" min="' + m.min + '" value="' + val + '" />';
                case 'string':
                    return '<input type="text" id="' + id + '" data-key="' + key + '" value="' + escapeHtmlClient(val ?? '') + '" placeholder="' + escapeHtmlClient(m.placeholder || '') + '" />';
                case 'startAt':
                    return '<input type="text" id="' + id + '" data-key="' + key + '" value="' + escapeHtmlClient(String(val ?? 0)) + '" placeholder="seconds or m:ss" />';
                case 'idle': {
                    const numVal = val == null ? '' : val;
                    return '<input type="text" id="' + id + '" data-key="' + key + '" value="' + numVal + '" placeholder="(use cast file value)" />';
                }
                case 'loop': {
                    if (typeof val === 'boolean') {
                        return '<select id="' + id + '" data-key="' + key + '"><option value="false"' + (val === false ? ' selected' : '') + '>No</option><option value="true"' + (val === true ? ' selected' : '') + '>Yes (infinite)</option></select>';
                    }
                    return '<input type="number" id="' + id + '" data-key="' + key + '" min="0" step="1" value="' + val + '" placeholder="loop N times" />';
                }
                case 'fontSize':
                    return '<input type="text" id="' + id + '" data-key="' + key + '" value="' + escapeHtmlClient(val ?? 'small') + '" placeholder="small | medium | big | 15px" list="font-size-presets" />' +
                        '<datalist id="font-size-presets"><option value="small"><option value="medium"><option value="big"></datalist>';
            }
            return '';
        }

        function renderPanel() {
            const sourceLabel = { instance: 'Cast', global: 'Global', default: 'Default' };
            let html = '<div class="panel-header">' +
                '<span class="panel-title">⚙ Player settings</span>' +
                '<button class="panel-close" type="button" id="panel-close">✕</button>' +
                '</div>' +
                '<div class="scope-tabs">' +
                '<button class="scope-tab' + (scope === 'instance' ? ' active' : '') + '" data-scope="instance">This cast</button>' +
                '<button class="scope-tab' + (scope === 'global' ? ' active' : '') + '" data-scope="global">Global defaults</button>' +
                '</div>';

            for (const grp of GROUPS) {
                html += '<div class="group-title">' + grp.title + '</div>';
                for (const key of grp.keys) {
                    const val = valueForScope(key);
                    const src = sourceFor(key);
                    const canReset = (scope === 'instance' && key in state.instance) ||
                                     (scope === 'global' && key in state.global);
                    html += '<div class="opt-row">' +
                        '<label for="opt-' + key + '">' + META[key].label + '</label>' +
                        controlHtml(key, val) +
                        '<div style="display:flex;align-items:center;gap:6px">' +
                        '<span class="opt-source s-' + src + '" title="' + sourceLabel[src] + '">' + src.charAt(0).toUpperCase() + '</span>' +
                        '<button class="reset-btn" data-reset="' + key + '" type="button" title="Reset to next layer"' + (canReset ? '' : ' disabled') + '>↺</button>' +
                        '</div>' +
                        '</div>';
                }
            }

            html += '<div class="panel-actions">';
            if (scope === 'instance') {
                html += '<button class="secondary" id="reset-cast" type="button">Reset all overrides for this cast</button>';
                html += '<button class="secondary" id="promote-global" type="button">Save current overrides as global defaults</button>';
            }
            html += '<a href="#" id="open-settings">Open in VS Code Settings ▸</a>' +
                '</div>';

            panel.innerHTML = html;
            wirePanel();
        }

        function wirePanel() {
            panel.querySelector('#panel-close').addEventListener('click', function() {
                cog.classList.remove('open');
            });
            for (const t of panel.querySelectorAll('.scope-tab')) {
                t.addEventListener('click', function() {
                    scope = this.getAttribute('data-scope');
                    renderPanel();
                });
            }
            for (const inp of panel.querySelectorAll('[data-key]')) {
                const evt = inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'change' : 'change';
                inp.addEventListener(evt, function() { applyChange(this); });
            }
            for (const r of panel.querySelectorAll('[data-reset]')) {
                r.addEventListener('click', function() { resetOne(this.getAttribute('data-reset')); });
            }
            const rc = panel.querySelector('#reset-cast');
            if (rc) rc.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'setInstance', overrides: {} });
            });
            const pg = panel.querySelector('#promote-global');
            if (pg) pg.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'promoteInstanceToGlobal' });
            });
            const os = panel.querySelector('#open-settings');
            if (os) os.addEventListener('click', function(e) {
                e.preventDefault();
                vscodeApi.postMessage({ type: 'openSettings' });
            });
        }

        function readControlValue(el) {
            const key = el.getAttribute('data-key');
            const m = META[key];
            switch (m.kind) {
                case 'bool': return el.checked;
                case 'number': {
                    const n = parseFloat(el.value);
                    return Number.isFinite(n) ? n : undefined;
                }
                case 'enum': return el.value;
                case 'startAt': {
                    const v = el.value.trim();
                    if (v === '') return 0;
                    if (/^\\d+(\\.\\d+)?$/.test(v)) return parseFloat(v);
                    return v;
                }
                case 'idle': {
                    const v = el.value.trim();
                    if (v === '') return null;
                    const n = parseFloat(v);
                    return Number.isFinite(n) && n >= 0 ? n : undefined;
                }
                case 'loop': {
                    if (el.tagName === 'SELECT') return el.value === 'true';
                    const n = parseInt(el.value, 10);
                    return Number.isFinite(n) && n >= 0 ? n : undefined;
                }
                case 'string': return el.value;
                case 'fontSize': return el.value || 'small';
            }
        }

        function applyChange(el) {
            const key = el.getAttribute('data-key');
            const value = readControlValue(el);
            if (value === undefined) return;
            if (scope === 'instance') {
                const next = Object.assign({}, state.instance);
                if (JSON.stringify(value) === JSON.stringify(state.global[key] ?? state.defaults[key])) {
                    delete next[key];
                } else {
                    next[key] = value;
                }
                vscodeApi.postMessage({ type: 'setInstance', overrides: next });
            } else {
                vscodeApi.postMessage({ type: 'setGlobal', patch: { [key]: value } });
            }
        }

        function resetOne(key) {
            if (scope === 'instance') {
                const next = Object.assign({}, state.instance);
                delete next[key];
                vscodeApi.postMessage({ type: 'setInstance', overrides: next });
            } else {
                vscodeApi.postMessage({ type: 'resetGlobalKey', key: key });
            }
        }

        // ─── Inbound messages ─────────────────────────────────────────
        window.addEventListener('message', function(ev) {
            const m = ev.data;
            if (!m || m.type !== 'options') return;
            state = Object.assign({}, state, {
                defaults: m.defaults,
                global: m.global,
                instance: m.instance,
                merged: m.merged,
                source: m.source,
                rowsOverride: m.rowsOverride !== undefined ? m.rowsOverride : state.rowsOverride,
            });
            createPlayer();
            if (cog.classList.contains('open')) renderPanel();
        });

        // ─── Meta-items collapse toggle ───────────────────────────────
        const metaItemsEl = document.getElementById('meta-items');
        const metaToggle = document.getElementById('meta-toggle');
        metaToggle.addEventListener('click', function() {
            const collapsed = metaItemsEl.classList.toggle('collapsed');
            metaToggle.setAttribute('data-tooltip', collapsed ? 'Expand badges' : 'Collapse badges');
        });

        // ─── Initial player creation + theme observer ─────────────────
        try {
            createPlayer();
        } catch (err) {
            document.body.innerHTML = '<pre style="color:#f44;padding:2em;">' +
                'Failed to initialize asciinema player:\\n' + err + '</pre>';
        }

        const observer = new MutationObserver(function(mutations) {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    if (state.merged.theme === 'auto') createPlayer();
                    break;
                }
            }
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
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

/** Re-export so callers don't need a separate import. */
export { toPlayerCreateOptions };
