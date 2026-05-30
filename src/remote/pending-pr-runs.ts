import * as vscode from "vscode";
import type { PullRequestCoordinates } from "./parse-pr-url.js";
import {
    listJobsForRun,
    listWorkflowRunsForSha,
    type PullRequestHead,
    type WorkflowJobSummary,
    type WorkflowRunSummary,
} from "./github-client.js";
import { conclusionIcon, formatRelativeTime } from "./quickpick-helpers.js";
import {
    isWorkflowJobActive,
    isWorkflowRunCandidate,
} from "./workflow-run-state.js";

const REFRESH_MS = 10_000;
const MAX_RUNS_WITH_JOBS = 20;

const REFRESH_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("refresh"),
    tooltip: "Refresh workflow runs",
};
const OPEN_PR_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("git-pull-request"),
    tooltip: "Open pull request on github.com",
};

interface RunWithJobs {
    readonly run: WorkflowRunSummary;
    readonly jobs: readonly WorkflowJobSummary[];
    readonly jobsError?: string;
}

interface PendingRunQuickPickItem extends vscode.QuickPickItem {
    readonly id: string;
    readonly run?: WorkflowRunSummary;
    readonly action?: "open-pr" | "refresh";
}

/**
 * Shows a live QuickPick for PR head-SHA workflow runs that are active or just
 * completed. Run rows and job rows both select the parent run, so the next step
 * can wait for artifacts and continue through the shared CI-run flow.
 */
export async function pickActiveWorkflowRunForPullRequest(
    token: string,
    coords: PullRequestCoordinates,
    head: PullRequestHead
): Promise<WorkflowRunSummary | undefined> {
    return await new Promise<WorkflowRunSummary | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<PendingRunQuickPickItem>();
        let disposed = false;
        let settled = false;
        let refreshing = false;
        let lastRows: readonly RunWithJobs[] = [];
        let lastUpdatedAt: Date | undefined;
        const timer: { interval?: ReturnType<typeof setInterval> } = {};

        const finish = (run: WorkflowRunSummary | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(run);
            if (!disposed) {
                qp.hide();
            }
        };

        const setItems = (items: readonly PendingRunQuickPickItem[]) => {
            if (disposed) {
                return;
            }
            const activeId = qp.activeItems[0]?.id;
            qp.items = items;
            if (activeId) {
                const nextActive = items.find((item) => item.id === activeId);
                if (nextActive) {
                    qp.activeItems = [nextActive];
                }
            }
        };

        const refresh = async () => {
            if (refreshing || disposed) {
                return;
            }
            refreshing = true;
            qp.busy = true;
            try {
                const runs = await listWorkflowRunsForSha(
                    token,
                    coords,
                    head.sha,
                    { perPage: 50 }
                );
                const candidateRuns = runs
                    .filter((run) => isWorkflowRunCandidate(run))
                    .slice(0, MAX_RUNS_WITH_JOBS);
                lastRows = await Promise.all(
                    candidateRuns.map(async (run) => {
                        try {
                            return {
                                run,
                                jobs: await listJobsForRun(token, coords, run.id),
                            };
                        } catch (err) {
                            return {
                                run,
                                jobs: [],
                                jobsError: (err as Error).message,
                            };
                        }
                    })
                );
                lastUpdatedAt = new Date();
                setItems(buildItems(coords, head, lastRows, lastUpdatedAt));
                qp.placeholder = buildPlaceholder(lastRows, lastUpdatedAt);
            } catch (err) {
                setItems(buildErrorItems(coords, head, err));
                qp.placeholder =
                    "Could not refresh GitHub Actions runs — press refresh to retry";
            } finally {
                refreshing = false;
                if (!disposed) {
                    qp.busy = false;
                }
            }
        };

        qp.title = `GitHub Artifacts — workflow runs for PR #${coords.number}`;
        qp.placeholder = "Loading GitHub Actions runs for this PR…";
        qp.step = 2;
        qp.totalSteps = 3;
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.ignoreFocusOut = true;
        qp.keepScrollPosition = true;
        qp.buttons = [REFRESH_BTN, OPEN_PR_BTN];
        qp.items = [
            {
                id: "loading",
                label: "$(sync~spin)  Loading GitHub Actions runs…",
                description: head.sha.slice(0, 7),
            },
        ];

        qp.onDidTriggerButton((button) => {
            if (button === REFRESH_BTN) {
                void refresh();
                return;
            }
            if (button === OPEN_PR_BTN) {
                void vscode.env.openExternal(vscode.Uri.parse(head.htmlUrl));
            }
        });

        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            if (picked?.run) {
                finish(picked.run);
                return;
            }
            if (picked?.action === "open-pr") {
                void vscode.env.openExternal(vscode.Uri.parse(head.htmlUrl));
                return;
            }
            if (picked?.action === "refresh") {
                void refresh();
            }
        });

        qp.onDidHide(() => {
            disposed = true;
            if (timer.interval) {
                clearInterval(timer.interval);
            }
            qp.dispose();
            if (!settled) {
                settled = true;
                resolve(undefined);
            }
        });

        timer.interval = setInterval(() => void refresh(), REFRESH_MS);
        qp.show();
        void refresh();
    });
}

function buildItems(
    coords: PullRequestCoordinates,
    head: PullRequestHead,
    rows: readonly RunWithJobs[],
    lastUpdatedAt: Date | undefined
): PendingRunQuickPickItem[] {
    if (rows.length === 0) {
        return [
            {
                id: "empty",
                label: "$(circle-slash)  No active or recent GitHub Actions runs",
                description: `${coords.owner}/${coords.repo}#${coords.number} @ ${head.sha.slice(0, 7)}`,
                detail: "No active or recently completed Actions runs for this commit. External CI providers are not shown here.",
            },
            {
                id: "open-pr",
                label: "$(link-external)  Open PR in browser",
                description: "View checks on github.com",
                action: "open-pr",
            },
        ];
    }

    const items: PendingRunQuickPickItem[] = [
        {
            id: "runs",
            label: lastUpdatedAt
                ? `Workflow runs — refreshed ${lastUpdatedAt.toLocaleTimeString()}`
                : "Workflow runs",
            kind: vscode.QuickPickItemKind.Separator,
        },
    ];
    for (const row of rows) {
        items.push(buildRunItem(row));
        if (row.jobsError) {
            items.push({
                id: `run:${row.run.id}:jobs-error`,
                label: "$(warning)  Couldn't list jobs",
                description: row.jobsError,
                detail: "Press Enter to wait on the parent workflow run anyway.",
                run: row.run,
            });
        } else if (row.jobs.length === 0) {
            items.push({
                id: `run:${row.run.id}:jobs-empty`,
                label: "$(circle-outline)  Jobs not reported yet",
                description: "Press Enter to wait on this workflow run",
                run: row.run,
            });
        } else {
            for (const job of row.jobs) {
                items.push(buildJobItem(row.run, job));
            }
        }
    }
    return items;
}

function buildRunItem(row: RunWithJobs): PendingRunQuickPickItem {
    const run = row.run;
    const state = describeState(run.status, run.conclusion);
    const jobSummary = summarizeJobs(row.jobs);
    return {
        id: `run:${run.id}`,
        label: `${conclusionIcon(run.conclusion ?? run.status)}  ${run.name ?? "workflow"} #${run.runNumber}`,
        description: `${state} · ${jobSummary}`,
        detail: `${run.headBranch ?? "(detached)"}@${run.headSha.slice(0, 7)} · started ${formatRelativeTime(run.createdAt)}`,
        run,
    };
}

function buildJobItem(
    run: WorkflowRunSummary,
    job: WorkflowJobSummary
): PendingRunQuickPickItem {
    const state = describeState(job.status, job.conclusion);
    return {
        id: `run:${run.id}:job:${job.id}`,
        label: `$(circle-small-filled)  ${job.name}`,
        description: `${conclusionIcon(job.conclusion ?? job.status)} ${state}`,
        detail: "Press Enter to wait on the parent workflow run.",
        run,
    };
}

function buildErrorItems(
    coords: PullRequestCoordinates,
    head: PullRequestHead,
    err: unknown
): PendingRunQuickPickItem[] {
    return [
        {
            id: "error",
            label: "$(error)  Couldn't list GitHub Actions runs",
            description: (err as Error).message,
            detail: `${coords.owner}/${coords.repo}#${coords.number} @ ${head.sha.slice(0, 7)}`,
        },
        {
            id: "refresh",
            label: "$(refresh)  Try again",
            action: "refresh",
        },
        {
            id: "open-pr",
            label: "$(link-external)  Open PR in browser",
            action: "open-pr",
        },
    ];
}

function buildPlaceholder(
    rows: readonly RunWithJobs[],
    lastUpdatedAt: Date | undefined
): string {
    if (rows.length === 0) {
        return "No active or recent GitHub Actions runs found — refresh or open the PR";
    }
    const updated = lastUpdatedAt
        ? ` · updated ${lastUpdatedAt.toLocaleTimeString()}`
        : "";
    return `Pick a run or job to wait for artifacts${updated}`;
}

function summarizeJobs(jobs: readonly WorkflowJobSummary[]): string {
    if (jobs.length === 0) {
        return "jobs pending";
    }
    const completed = jobs.filter((j) => j.status === "completed").length;
    const active = jobs.filter((j) => isWorkflowJobActive(j)).length;
    const queued = Math.max(jobs.length - completed - active, 0);
    return `${completed}/${jobs.length} jobs complete, ${active} running, ${queued} queued`;
}

function describeState(
    status: string | null,
    conclusion: string | null
): string {
    return conclusion ?? status ?? "unknown";
}
