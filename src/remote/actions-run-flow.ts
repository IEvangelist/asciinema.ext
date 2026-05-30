import * as vscode from "vscode";
import { fromActionsRun, type ArtifactSource } from "./artifact-source.js";
import type { ActionsRunCoordinates } from "./parse-run-url.js";
import {
    getGitHubSession,
    getWorkflowRunById,
    listArtifactsForRun,
    listJobsForRun,
    type WorkflowArtifact,
    type WorkflowJobSummary,
    type WorkflowRunSummary,
} from "./github-client.js";
import {
    handleApiError,
    pickAndOpenArtifact,
} from "./download-and-open.js";
import { showQuickPick } from "./artifact-handlers/quickpick.js";
import { conclusionIcon } from "./quickpick-helpers.js";
import {
    isWorkflowJobActive,
    isWorkflowRunActive,
} from "./workflow-run-state.js";

const WAIT_POLL_MS = 10_000;

export interface RunActionsRunFlowOptions {
    readonly initialRun?: WorkflowRunSummary;
    readonly source?: ArtifactSource;
    readonly waitIfNotReady?: boolean;
}

type EmptyRunAction = "wait" | "refresh" | "open";
type ContinueAction = "continue" | "open";

interface ActionQuickPickItem<TAction extends string>
    extends vscode.QuickPickItem {
    readonly action: TAction;
}

type WaitResult =
    | {
          readonly kind: "ready";
          readonly run: WorkflowRunSummary;
          readonly artifacts: WorkflowArtifact[];
      }
    | { readonly kind: "completed-empty"; readonly run: WorkflowRunSummary }
    | { readonly kind: "cancelled" };

export async function runActionsRunFlow(
    context: vscode.ExtensionContext,
    coords: ActionsRunCoordinates,
    options: RunActionsRunFlowOptions = {}
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;
    const repo = { owner: coords.owner, repo: coords.repo };
    const runUrl = `https://github.com/${coords.owner}/${coords.repo}/actions/runs/${coords.runId}`;

    let run = options.initialRun;
    if (!run) {
        try {
            run = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `GitHub Artifacts — Looking up run ${coords.owner}/${coords.repo} #${coords.runId}`,
                },
                () => getWorkflowRunById(token, repo, coords.runId)
            );
        } catch (err) {
            await handleApiError(err, {
                notFoundMessage: `Couldn't access run ${coords.owner}/${coords.repo} #${coords.runId}.`,
                fallbackLabel: "Open Run in Browser",
                fallbackUrl: runUrl,
                retry: () => runActionsRunFlow(context, coords, options),
            });
            return;
        }
    }

    const source = options.source ?? fromActionsRun(coords);
    let artifacts: WorkflowArtifact[];
    for (;;) {
        try {
            artifacts = await listRunArtifacts(token, repo, run);
        } catch (err) {
            await handleApiError(err, {
                notFoundMessage: "Failed to list artifacts for this run.",
                fallbackLabel: "Open Run in Browser",
                fallbackUrl: run.htmlUrl,
                retry: () => runActionsRunFlow(context, coords, options),
            });
            return;
        }

        if (artifacts.length > 0) {
            await pickAndOpenArtifact(context, source, run, artifacts, {
                fallbackLabel: "Open Run in Browser",
                fallbackUrl: run.htmlUrl,
            });
            return;
        }

        const action =
            options.waitIfNotReady && isWorkflowRunActive(run)
                ? "wait"
                : await pickEmptyRunAction(run);
        if (!action) {
            return;
        }
        if (action === "open") {
            await vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl));
            return;
        }
        if (action === "refresh") {
            try {
                run = await getWorkflowRunById(token, repo, run.id);
            } catch (err) {
                await handleApiError(err, {
                    notFoundMessage: "Failed to refresh this workflow run.",
                    fallbackLabel: "Open Run in Browser",
                    fallbackUrl: run.htmlUrl,
                    retry: () => runActionsRunFlow(context, coords, options),
                });
                return;
            }
            continue;
        }

        let waitResult: WaitResult;
        try {
            waitResult = await waitForRunArtifacts(token, repo, run);
        } catch (err) {
            await handleApiError(err, {
                notFoundMessage: "Failed while waiting for this workflow run.",
                fallbackLabel: "Open Run in Browser",
                fallbackUrl: run.htmlUrl,
                retry: () => runActionsRunFlow(context, coords, options),
            });
            return;
        }

        if (waitResult.kind === "cancelled") {
            return;
        }
        run = waitResult.run;
        if (waitResult.kind === "completed-empty") {
            options = { ...options, waitIfNotReady: false };
            continue;
        }

        const continueAction = await pickContinueAction(
            waitResult.run,
            waitResult.artifacts
        );
        if (!continueAction) {
            return;
        }
        if (continueAction === "open") {
            await vscode.env.openExternal(vscode.Uri.parse(waitResult.run.htmlUrl));
            return;
        }
        await pickAndOpenArtifact(
            context,
            source,
            waitResult.run,
            waitResult.artifacts,
            {
                fallbackLabel: "Open Run in Browser",
                fallbackUrl: waitResult.run.htmlUrl,
            }
        );
        return;
    }
}

async function listRunArtifacts(
    token: string,
    repo: { readonly owner: string; readonly repo: string },
    run: WorkflowRunSummary
): Promise<WorkflowArtifact[]> {
    return await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "GitHub Artifacts — Listing artifacts for run",
        },
        () => listArtifactsForRun(token, repo, run.id)
    );
}

async function pickEmptyRunAction(
    run: WorkflowRunSummary
): Promise<EmptyRunAction | undefined> {
    const active = isWorkflowRunActive(run);
    const items: ActionQuickPickItem<EmptyRunAction>[] = active
        ? [
              {
                  label: "$(watch)  Wait for artifacts",
                  description: describeRunState(run),
                  detail: "Poll this workflow run until artifacts are available or the run completes.",
                  action: "wait",
              },
              {
                  label: "$(refresh)  Refresh now",
                  description: "Check this run again",
                  action: "refresh",
              },
              {
                  label: "$(link-external)  Open run in browser",
                  description: "View logs, approvals, and live job output",
                  action: "open",
              },
          ]
        : [
              {
                  label: "$(refresh)  Refresh artifacts",
                  description: "Check this completed run again",
                  detail: "Use this if artifacts finished uploading after the last check.",
                  action: "refresh",
              },
              {
                  label: "$(link-external)  Open run in browser",
                  description: "No non-expired artifacts found",
                  action: "open",
              },
          ];

    const picked = await showQuickPick(items, {
        title: `GitHub Artifacts — ${run.name ?? "workflow"} #${run.runNumber}`,
        placeholder: active
            ? "This run is not ready yet — wait, refresh, or open it in GitHub"
            : "This run completed without non-expired artifacts",
        step: 2,
        totalSteps: 3,
    });
    return picked?.action;
}

async function waitForRunArtifacts(
    token: string,
    repo: { readonly owner: string; readonly repo: string },
    initialRun: WorkflowRunSummary
): Promise<WaitResult> {
    return await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `GitHub Artifacts — Waiting for ${initialRun.name ?? "workflow"} #${initialRun.runNumber}`,
            cancellable: true,
        },
        async (progress, cancellation) => {
            let run = initialRun;
            while (true) {
                if (cancellation.isCancellationRequested) {
                    return { kind: "cancelled" };
                }

                const artifacts = await listArtifactsForRun(token, repo, run.id);
                if (artifacts.length > 0) {
                    return { kind: "ready", run, artifacts };
                }

                run = await getWorkflowRunById(token, repo, run.id);
                let jobs: WorkflowJobSummary[] = [];
                let jobsError: string | undefined;
                try {
                    jobs = await listJobsForRun(token, repo, run.id);
                } catch (err) {
                    jobsError = (err as Error).message;
                    jobs = [];
                }

                progress.report({
                    message: describeWaitProgress(run, jobs, jobsError),
                });

                if (!isWorkflowRunActive(run)) {
                    return { kind: "completed-empty", run };
                }

                const shouldContinue = await delay(WAIT_POLL_MS, cancellation);
                if (!shouldContinue) {
                    return { kind: "cancelled" };
                }
            }
        }
    );
}

async function pickContinueAction(
    run: WorkflowRunSummary,
    artifacts: readonly WorkflowArtifact[]
): Promise<ContinueAction | undefined> {
    const picked = await showQuickPick<ActionQuickPickItem<ContinueAction>>(
        [
            {
                label: "$(play)  Continue with this run",
                description: `${artifacts.length} ${artifacts.length === 1 ? "artifact" : "artifacts"} ready`,
                detail: "Open the artifact picker for this workflow run.",
                action: "continue",
            },
            {
                label: "$(link-external)  Open run in browser",
                description: `${run.name ?? "workflow"} #${run.runNumber}`,
                action: "open",
            },
        ],
        {
            title: "GitHub Artifacts — run is ready",
            placeholder: "Artifacts are ready — continue to the artifact picker",
            step: 3,
            totalSteps: 3,
        }
    );
    return picked?.action;
}

function describeRunState(run: WorkflowRunSummary): string {
    return run.conclusion ?? run.status ?? "unknown";
}

function describeWaitProgress(
    run: WorkflowRunSummary,
    jobs: readonly WorkflowJobSummary[],
    jobsError?: string
): string {
    const state = describeRunState(run);
    if (jobsError) {
        return `${conclusionIcon(run.conclusion ?? run.status)} ${state} · jobs unavailable: ${jobsError} · waiting for artifacts`;
    }
    if (jobs.length === 0) {
        return `${state} · waiting for jobs/artifacts`;
    }

    const completed = jobs.filter((j) => j.status === "completed").length;
    const active = jobs.filter((j) => isWorkflowJobActive(j)).length;
    const queued = jobs.length - completed - active;
    return `${conclusionIcon(run.conclusion ?? run.status)} ${state} · ${completed}/${jobs.length} jobs complete · ${active} running · ${Math.max(queued, 0)} queued`;
}

function delay(
    ms: number,
    cancellation: vscode.CancellationToken
): Promise<boolean> {
    if (cancellation.isCancellationRequested) {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const state: { sub?: vscode.Disposable } = {};
        const timer = setTimeout(() => {
            state.sub?.dispose();
            resolve(true);
        }, ms);
        state.sub = cancellation.onCancellationRequested(() => {
            clearTimeout(timer);
            state.sub?.dispose();
            resolve(false);
        });
    });
}

async function acquireSession(): Promise<
    vscode.AuthenticationSession | undefined
> {
    const existing = await getGitHubSession(false);
    if (existing) {
        return existing;
    }
    const session = await getGitHubSession(true);
    if (session) {
        return session;
    }
    const choice = await vscode.window.showErrorMessage(
        "GitHub sign-in is required to download CI artifacts.",
        "Sign in"
    );
    if (choice === "Sign in") {
        return await getGitHubSession(true);
    }
    return undefined;
}
