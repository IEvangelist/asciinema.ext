import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatBytesShort,
    formatRelativeTime,
    conclusionIcon,
    parseCastDurationSeconds,
    formatDurationShort,
} from "../quickpick-helpers.js";

describe("formatBytesShort", () => {
    it("formats bytes under 1 KB", () => {
        assert.equal(formatBytesShort(0), "0 B");
        assert.equal(formatBytesShort(512), "512 B");
    });
    it("formats KB / MB / GB", () => {
        assert.equal(formatBytesShort(2048), "2.0 KB");
        assert.equal(formatBytesShort(5 * 1024 * 1024), "5.0 MB");
        assert.equal(formatBytesShort(2.5 * 1024 * 1024 * 1024), "2.50 GB");
    });
    it("guards against negative / NaN", () => {
        assert.equal(formatBytesShort(-1), "0 B");
        assert.equal(formatBytesShort(NaN), "0 B");
    });
});

describe("formatRelativeTime", () => {
    const now = new Date("2025-06-01T12:00:00Z");
    it("formats sub-minute as just-now or seconds", () => {
        assert.equal(
            formatRelativeTime("2025-06-01T11:59:59Z", now),
            "just now"
        );
        assert.equal(
            formatRelativeTime("2025-06-01T11:59:30Z", now),
            "30s ago"
        );
    });
    it("formats minutes/hours/days/weeks", () => {
        assert.equal(
            formatRelativeTime("2025-06-01T11:55:00Z", now),
            "5m ago"
        );
        assert.equal(
            formatRelativeTime("2025-06-01T09:00:00Z", now),
            "3h ago"
        );
        assert.equal(
            formatRelativeTime("2025-05-30T12:00:00Z", now),
            "2d ago"
        );
        assert.equal(
            formatRelativeTime("2025-05-18T12:00:00Z", now),
            "2w ago"
        );
    });
    it("returns input unchanged on invalid date", () => {
        assert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
    });
});

describe("conclusionIcon", () => {
    it("maps known conclusions to codicons", () => {
        assert.equal(conclusionIcon("success"), "$(pass)");
        assert.equal(conclusionIcon("failure"), "$(error)");
        assert.equal(conclusionIcon("cancelled"), "$(circle-slash)");
        assert.equal(conclusionIcon("in_progress"), "$(sync~spin)");
    });
    it("falls back for unknown / null", () => {
        assert.equal(conclusionIcon(null), "$(question)");
        assert.equal(conclusionIcon("totally-new-state"), "$(question)");
    });
});

describe("parseCastDurationSeconds", () => {
    const enc = new TextEncoder();
    it("returns header.duration when present", () => {
        const cast = enc.encode(
            '{"version":2,"width":80,"height":24,"duration":42.5}\n[0.1,"o","hi"]\n'
        );
        assert.equal(parseCastDurationSeconds(cast), 42.5);
    });
    it("falls back to last event timestamp", () => {
        const cast = enc.encode(
            '{"version":2,"width":80,"height":24}\n[0.1,"o","a"]\n[3.7,"o","b"]\n'
        );
        assert.equal(parseCastDurationSeconds(cast), 3.7);
    });
    it("returns undefined for malformed/empty input", () => {
        assert.equal(parseCastDurationSeconds(new Uint8Array()), undefined);
        assert.equal(
            parseCastDurationSeconds(enc.encode("not json at all")),
            undefined
        );
    });
});

describe("formatDurationShort", () => {
    it("returns undefined for invalid", () => {
        assert.equal(formatDurationShort(undefined), undefined);
        assert.equal(formatDurationShort(NaN), undefined);
        assert.equal(formatDurationShort(-1), undefined);
    });
    it("formats seconds / minutes / hours", () => {
        assert.equal(formatDurationShort(38), "38s");
        assert.equal(formatDurationShort(102), "1m 42s");
        assert.equal(formatDurationShort(842), "14m 02s");
        assert.equal(formatDurationShort(3725), "1h 02m");
    });
});
