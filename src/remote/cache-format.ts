/**
 * Pure formatting helpers used by the cache-clear command and various
 * QuickPick rows. Lives in a vscode-free module so it can be exercised
 * by node:test without needing to mock the editor surface.
 */

/**
 * Format a byte count in human-friendly units (e.g. `1.4 GB`, `420 MB`,
 * `12 MB`, `512 B`).
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    if (i === 0) {
        return `${Math.round(value)} ${units[i]}`;
    }
    return value >= 100
        ? `${value.toFixed(0)} ${units[i]}`
        : value >= 10
          ? `${value.toFixed(1)} ${units[i]}`
          : `${value.toFixed(2)} ${units[i]}`;
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
});

/**
 * Render a `[min, max]` UNIX-ms range as a single date (when collapsed)
 * or two dates joined by an en-dash. Returns the empty string for
 * non-finite inputs.
 */
export function formatDateRange(min: number, max: number): string {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return "";
    }
    const lo = DATE_FMT.format(new Date(min));
    const hi = DATE_FMT.format(new Date(max));
    return lo === hi ? lo : `${lo} – ${hi}`;
}
