/**
 * Small helpers for building progress notification messages used by the
 * download + extraction phases of the Artifacts Explorer command.
 *
 * VS Code's `withProgress` notification renders the `message` field as a
 * plain DOM text node inside a `<span>` with default `white-space`, so:
 *   - `\n` newlines collapse to whitespace (no vertical layout)
 *   - `$(name)` codicon tokens render as literal text
 *
 * We therefore lay out facts on a single line separated by ` · `, and use
 * emoji glyphs (which DO render) instead of `$(name)` codicon tokens as
 * the leading visual marker for each fact.
 */

import { formatBytesShort } from "./quickpick-helpers.js";

/**
 * Formats a duration in milliseconds as a short, human-friendly string:
 *   850ms  → "<1s"
 *   3_200  → "3s"
 *   65_000 → "1m 5s"
 *   3_725_000 → "1h 2m"
 */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
        return "0s";
    }
    if (ms < 1000) {
        return "<1s";
    }
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

/**
 * Formats a transfer rate (bytes/sec) using `formatBytesShort` for the
 * numerator. Returns an empty string for non-finite or non-positive
 * inputs so callers can omit the field entirely.
 */
export function formatRate(bytesPerSec: number): string {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
        return "";
    }
    return `${formatBytesShort(bytesPerSec)}/s`;
}

/**
 * Estimates remaining time given elapsed time and the fraction completed
 * in [0, 1]. Returns `undefined` when the estimate isn't yet meaningful
 * (no elapsed time, no progress, or already complete).
 */
export function estimateEtaMs(
    elapsedMs: number,
    fraction: number
): number | undefined {
    if (
        !Number.isFinite(elapsedMs) ||
        !Number.isFinite(fraction) ||
        elapsedMs <= 0 ||
        fraction <= 0 ||
        fraction >= 1
    ) {
        return undefined;
    }
    const totalEstimate = elapsedMs / fraction;
    const remaining = totalEstimate - elapsedMs;
    return remaining > 0 ? remaining : undefined;
}

export interface ProgressLineInputs {
    /** Bytes received/written so far. */
    readonly received: number;
    /** Total expected bytes, when known. */
    readonly total?: number;
    /** ms since the phase started. */
    readonly elapsedMs: number;
    /**
     * Optional file-count info for the extraction phase. When present,
     * the headline line shows files instead of bytes-of-bytes.
     */
    readonly files?: {
        readonly written: number;
        readonly total: number;
    };
    /** Optional humorous quip to render on its own line. */
    readonly quip?: string;
}

/**
 * Separator placed between facts in the rendered progress message. We
 * use ` · ` (U+00B7 middle dot) because VS Code's notification renders
 * the `message` as plain text on a single (wrappable) line — `\n` does
 * not produce a line break here.
 */
const SEPARATOR = " · ";

/**
 * Builds a progress notification message as a ` · `-separated single line
 * with an emoji glyph in front of each fact. VS Code's progress renderer
 * does NOT process `$(name)` codicon tokens or honor `\n` in the message
 * field, so we use emoji (which render universally) and a middle-dot
 * separator that still reads as a list when the toast wraps.
 *
 * Download layout (when total is known):
 *
 *   📥 458.3 MB of 695.1 MB · 📊 65% · ⚡ 12.4 MB/s · ⏱ 38s elapsed · ⏳ ~21s remaining · 🥖 You could've baked bread by now.
 *
 * Download layout (total unknown — rare; Content-Length missing):
 *
 *   📥 1.0 MB downloaded · ⚡ 5.5 MB/s · ⏱ 2s elapsed
 *
 * Extraction layout (when `files` is provided):
 *
 *   🗜 12,403 of 27,718 files (245.6 MB) · 📊 45% · ⚡ 18.0 MB/s · ⏱ 14s elapsed · ⏳ ~17s remaining · 🗜️ Squeezing the last bytes out…
 */
export function buildProgressMessage(input: ProgressLineInputs): string {
    const parts: string[] = [];
    const rate = formatRate(
        input.elapsedMs > 0 ? input.received / (input.elapsedMs / 1000) : 0
    );

    if (input.files) {
        // Extraction phase: file count is the headline fact, byte total
        // is a parenthetical so the eye still groups them as "how much
        // we've written" without merging them with the percentage segment.
        const writtenStr = input.files.written.toLocaleString();
        const totalStr = input.files.total.toLocaleString();
        const sizeStr = formatBytesShort(input.received);
        parts.push(`🗜 ${writtenStr} of ${totalStr} files (${sizeStr})`);
        if (input.files.total > 0) {
            const pct = Math.min(
                100,
                Math.floor((input.files.written / input.files.total) * 100)
            );
            parts.push(`📊 ${pct}%`);
        }
    } else {
        const recvStr = formatBytesShort(input.received);
        if (input.total && input.total > 0) {
            const totalStr = formatBytesShort(input.total);
            const pct = Math.min(
                100,
                Math.floor((input.received / input.total) * 100)
            );
            parts.push(`📥 ${recvStr} of ${totalStr}`);
            parts.push(`📊 ${pct}%`);
        } else {
            parts.push(`📥 ${recvStr} downloaded`);
        }
    }

    if (rate) {
        parts.push(`⚡ ${rate}`);
    }

    const elapsedStr = formatDuration(input.elapsedMs);
    parts.push(`⏱ ${elapsedStr} elapsed`);

    const fraction = input.files
        ? input.files.total > 0
            ? input.files.written / input.files.total
            : 0
        : input.total && input.total > 0
            ? input.received / input.total
            : 0;
    const etaMs = estimateEtaMs(input.elapsedMs, fraction);
    if (etaMs !== undefined) {
        parts.push(`⏳ ~${formatDuration(etaMs)} remaining`);
    }

    if (input.quip) {
        parts.push(input.quip);
    }

    return parts.join(SEPARATOR);
}
