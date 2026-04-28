/**
 * Small helpers for building multi-line progress notification messages used
 * by the download + extraction phases of the Artifacts Explorer command.
 *
 * VS Code's `withProgress` notification renders `\n` in the message as a
 * line break and grows vertically — we lean on that to give the user
 * size, throughput, ETA, elapsed time, and (optionally) a humorous quip
 * each on their own line.
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
 * Builds a multi-line progress message. Layout (download example):
 *
 *   458.3 MB of 695.1 MB · 65% · 12.4 MB/s
 *   Elapsed 38s · ~21s remaining
 *   🥖 You could've baked bread by now.
 *
 * For the extraction phase (when `files` is provided):
 *
 *   12,403 of 27,718 files · 245.6 MB · 45%
 *   Elapsed 14s · ~17s remaining · 18.0 MB/s
 *   🗜️ Squeezing the last bytes out…
 *
 * Lines are separated by `\n` which VS Code's notification renderer turns
 * into actual line breaks.
 */
export function buildProgressMessage(input: ProgressLineInputs): string {
    const lines: string[] = [];

    // Line 1 — primary size / count.
    if (input.files) {
        const pct =
            input.files.total > 0
                ? Math.min(
                      100,
                      Math.floor(
                          (input.files.written / input.files.total) * 100
                      )
                  )
                : 0;
        const writtenStr = input.files.written.toLocaleString();
        const totalStr = input.files.total.toLocaleString();
        const sizeStr = formatBytesShort(input.received);
        lines.push(
            `${writtenStr} of ${totalStr} files · ${sizeStr} · ${pct}%`
        );
    } else {
        const recvStr = formatBytesShort(input.received);
        if (input.total && input.total > 0) {
            const pct = Math.min(
                100,
                Math.floor((input.received / input.total) * 100)
            );
            const totalStr = formatBytesShort(input.total);
            const rate = formatRate(input.received / (input.elapsedMs / 1000));
            const head = `${recvStr} of ${totalStr} · ${pct}%`;
            lines.push(rate ? `${head} · ${rate}` : head);
        } else {
            const rate = formatRate(input.received / (input.elapsedMs / 1000));
            lines.push(rate ? `${recvStr} downloaded · ${rate}` : `${recvStr} downloaded`);
        }
    }

    // Line 2 — timing (elapsed + ETA + rate-when-files-known).
    const elapsedStr = formatDuration(input.elapsedMs);
    const fraction = input.files
        ? input.files.total > 0
            ? input.files.written / input.files.total
            : 0
        : input.total && input.total > 0
            ? input.received / input.total
            : 0;
    const etaMs = estimateEtaMs(input.elapsedMs, fraction);
    const timingParts = [`Elapsed ${elapsedStr}`];
    if (etaMs !== undefined) {
        timingParts.push(`~${formatDuration(etaMs)} remaining`);
    }
    if (input.files && input.elapsedMs > 0) {
        const rate = formatRate(input.received / (input.elapsedMs / 1000));
        if (rate) {
            timingParts.push(rate);
        }
    }
    lines.push(timingParts.join(" · "));

    // Line 3 — optional quip.
    if (input.quip) {
        lines.push(input.quip);
    }

    return lines.join("\n");
}
