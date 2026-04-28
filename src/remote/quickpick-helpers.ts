/**
 * Shared formatting and parsing helpers used by the various QuickPick UIs in
 * the "Open Artifact from GitHub Pull Request" flow.
 *
 * These are deliberately pure and free of `vscode` imports so they can be
 * unit-tested with `node:test`.
 */

export function formatBytesShort(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(
    iso: string,
    now: Date = new Date()
): string {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) {
        return iso;
    }
    const diffSec = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
    if (diffSec < 5) {
        return "just now";
    }
    if (diffSec < MINUTE) {
        return `${diffSec}s ago`;
    }
    if (diffSec < HOUR) {
        return `${Math.floor(diffSec / MINUTE)}m ago`;
    }
    if (diffSec < DAY) {
        return `${Math.floor(diffSec / HOUR)}h ago`;
    }
    if (diffSec < WEEK) {
        return `${Math.floor(diffSec / DAY)}d ago`;
    }
    if (diffSec < 30 * DAY) {
        return `${Math.floor(diffSec / WEEK)}w ago`;
    }
    if (diffSec < 365 * DAY) {
        return `${Math.floor(diffSec / (30 * DAY))}mo ago`;
    }
    return `${Math.floor(diffSec / (365 * DAY))}y ago`;
}

/**
 * Maps a GitHub workflow-run conclusion string to a VS Code codicon
 * suitable for inline display in QuickPick labels/descriptions.
 */
export function conclusionIcon(conclusion: string | null | undefined): string {
    switch ((conclusion ?? "").toLowerCase()) {
        case "success":
            return "$(pass)";
        case "failure":
            return "$(error)";
        case "cancelled":
            return "$(circle-slash)";
        case "skipped":
            return "$(debug-step-over)";
        case "timed_out":
            return "$(watch)";
        case "neutral":
            return "$(circle-outline)";
        case "action_required":
            return "$(warning)";
        case "in_progress":
        case "queued":
        case "pending":
        case "waiting":
        case "requested":
            return "$(sync~spin)";
        default:
            return "$(question)";
    }
}

/**
 * Best-effort extraction of an asciicast v2 recording's duration in seconds
 * from its raw bytes. Returns `undefined` when the duration can't be
 * determined (older v1 files, missing header field, malformed JSON, etc.).
 *
 * v2 files start with a single-line JSON header, e.g.:
 *   {"version":2,"width":80,"height":24,"duration":42.5,...}
 * Some recorders omit `duration` and instead let the player compute it from
 * the last event timestamp; we handle that as a fallback by reading the last
 * non-empty line.
 */
export function parseCastDurationSeconds(bytes: Uint8Array): number | undefined {
    // Look at just the first 4 KB for the header line.
    const headerSlice = bytes.subarray(0, Math.min(bytes.byteLength, 4096));
    const headerText = new TextDecoder("utf-8", { fatal: false }).decode(headerSlice);
    const newlineIdx = headerText.indexOf("\n");
    if (newlineIdx <= 0) {
        return undefined;
    }
    const headerLine = headerText.slice(0, newlineIdx).trim();
    if (!headerLine.startsWith("{")) {
        return undefined;
    }
    let header: { version?: number; duration?: number };
    try {
        header = JSON.parse(headerLine) as typeof header;
    } catch {
        return undefined;
    }
    if (typeof header.duration === "number" && Number.isFinite(header.duration)) {
        return header.duration;
    }

    // Fallback: scan the last ~8 KB for the final event's timestamp.
    const tailStart = Math.max(0, bytes.byteLength - 8192);
    const tailText = new TextDecoder("utf-8", { fatal: false }).decode(
        bytes.subarray(tailStart)
    );
    const lines = tailText.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith("[")) {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as unknown;
            if (Array.isArray(parsed) && typeof parsed[0] === "number") {
                return parsed[0];
            }
        } catch {
            // keep looking upstream
        }
    }
    return undefined;
}

export function formatDurationShort(seconds: number | undefined): string | undefined {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return undefined;
    }
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    }
    const totalSec = Math.round(seconds);
    const minutes = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (minutes < 60) {
        return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins.toString().padStart(2, "0")}m`;
}
