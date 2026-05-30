import type {
    WorkflowJobSummary,
    WorkflowRunSummary,
} from "./github-client.js";

export const RECENT_COMPLETED_RUN_MS = 10 * 60 * 1000;

type RunStatus = Pick<
    WorkflowRunSummary,
    "status" | "conclusion" | "createdAt" | "updatedAt"
>;

type JobStatus = Pick<WorkflowJobSummary, "status" | "conclusion">;

export function isWorkflowRunActive(
    run: Pick<RunStatus, "status" | "conclusion">
): boolean {
    return run.conclusion === null && run.status !== null && run.status !== "completed";
}

export function isWorkflowRunRecentlyCompleted(
    run: Pick<RunStatus, "status" | "createdAt" | "updatedAt">,
    nowMs = Date.now(),
    recentWindowMs = RECENT_COMPLETED_RUN_MS
): boolean {
    if (run.status !== "completed") {
        return false;
    }
    const updatedAt = new Date(run.updatedAt ?? run.createdAt).getTime();
    return Number.isFinite(updatedAt) && nowMs - updatedAt <= recentWindowMs;
}

export function isWorkflowRunCandidate(
    run: RunStatus,
    nowMs = Date.now(),
    recentWindowMs = RECENT_COMPLETED_RUN_MS
): boolean {
    return (
        isWorkflowRunActive(run) ||
        isWorkflowRunRecentlyCompleted(run, nowMs, recentWindowMs)
    );
}

export function isWorkflowJobActive(job: JobStatus): boolean {
    return job.conclusion === null && job.status !== null && job.status !== "completed";
}
