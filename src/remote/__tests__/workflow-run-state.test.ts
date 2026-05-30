import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    RECENT_COMPLETED_RUN_MS,
    isWorkflowJobActive,
    isWorkflowRunActive,
    isWorkflowRunCandidate,
    isWorkflowRunRecentlyCompleted,
} from "../workflow-run-state.js";

const NOW = Date.parse("2025-01-01T12:00:00Z");

function minutesAgo(minutes: number): string {
    return new Date(NOW - minutes * 60 * 1000).toISOString();
}

describe("workflow run state helpers", () => {
    it("identifies active workflow runs", () => {
        assert.equal(
            isWorkflowRunActive({ status: "queued", conclusion: null }),
            true
        );
        assert.equal(
            isWorkflowRunActive({ status: "in_progress", conclusion: null }),
            true
        );
        assert.equal(
            isWorkflowRunActive({ status: "completed", conclusion: "success" }),
            false
        );
        assert.equal(
            isWorkflowRunActive({ status: null, conclusion: null }),
            false
        );
    });

    it("keeps just-completed runs selectable briefly", () => {
        const run = {
            status: "completed",
            conclusion: "success",
            createdAt: minutesAgo(30),
            updatedAt: minutesAgo(5),
        };

        assert.equal(isWorkflowRunRecentlyCompleted(run, NOW), true);
        assert.equal(isWorkflowRunCandidate(run, NOW), true);
    });

    it("does not treat old completed runs as pending-picker candidates", () => {
        const run = {
            status: "completed",
            conclusion: "success",
            createdAt: minutesAgo(60),
            updatedAt: new Date(NOW - RECENT_COMPLETED_RUN_MS - 1).toISOString(),
        };

        assert.equal(isWorkflowRunRecentlyCompleted(run, NOW), false);
        assert.equal(isWorkflowRunCandidate(run, NOW), false);
    });

    it("identifies active workflow jobs", () => {
        assert.equal(
            isWorkflowJobActive({ status: "in_progress", conclusion: null }),
            true
        );
        assert.equal(
            isWorkflowJobActive({ status: "completed", conclusion: "failure" }),
            false
        );
    });
});
