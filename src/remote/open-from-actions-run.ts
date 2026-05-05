import * as vscode from "vscode";
import {
    parseActionsRunUrl,
    type ActionsRunCoordinates,
} from "./parse-run-url.js";
import {
    getGitHubSession,
    getWorkflowRunById,
    listArtifactsForRun,
    type WorkflowArtifact,
    type WorkflowRunSummary,
} from "./github-client.js";
import { fromActionsRun } from "./artifact-source.js";
import {
    handleApiError,
    pickAndOpenArtifact,
} from "./download-and-open.js";

/**
 * Command implementation for `asciinema.openFromActionsRun`.
 *
 * Accepts a GitHub Actions workflow-run URL, fetches the run summary and its
 * artifacts directly (no PR head-SHA resolution), and routes through the
 * shared artifact pick/download/extract/dispatch pipeline.
 */
export async function openFromActionsRunCommand(
    context: vscode.ExtensionContext,
    options: { prefilledUrl?: string } = {}
): Promise<void> {
    let rawUrl = options.prefilledUrl;
    if (!rawUrl) {
        rawUrl = await vscode.window.showInputBox({
            title: "GitHub — Open Artifacts from CI Run",
            prompt: "Paste a GitHub Actions workflow run URL",
            placeHolder:
                "https://github.com/owner/repo/actions/runs/1234567890",
            ignoreFocusOut: true,
            validateInput: (value) =>
                !value || parseActionsRunUrl(value)
                    ? undefined
                    : "Not a recognized GitHub Actions run URL",
        });
        if (!rawUrl) {
            return;
        }
    }

    const coords = parseActionsRunUrl(rawUrl);
    if (!coords) {
        await vscode.window.showErrorMessage(
            "That doesn't look like a GitHub Actions workflow run URL."
        );
        return;
    }

    await runFlow(context, coords);
}

async function runFlow(
    context: vscode.ExtensionContext,
    coords: ActionsRunCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;
    const repo = { owner: coords.owner, repo: coords.repo };
    const runUrl = `https://github.com/${coords.owner}/${coords.repo}/actions/runs/${coords.runId}`;

    let run: WorkflowRunSummary;
    try {
        run = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Asciinema — Looking up run ${coords.owner}/${coords.repo} #${coords.runId}`,
            },
            () => getWorkflowRunById(token, repo, coords.runId)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: `Couldn't access run ${coords.owner}/${coords.repo} #${coords.runId}.`,
            fallbackLabel: "Open Run in Browser",
            fallbackUrl: runUrl,
            retry: () => runFlow(context, coords),
        });
        return;
    }

    let artifacts: WorkflowArtifact[];
    try {
        artifacts = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Asciinema — Listing artifacts for run",
            },
            () => listArtifactsForRun(token, repo, coords.runId)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to list artifacts for this run.",
            fallbackLabel: "Open Run in Browser",
            fallbackUrl: run.htmlUrl,
            retry: () => runFlow(context, coords),
        });
        return;
    }

    if (artifacts.length === 0) {
        await reportNoArtifacts(run);
        return;
    }

    await pickAndOpenArtifact(
        context,
        fromActionsRun(coords),
        run,
        artifacts,
        {
            fallbackLabel: "Open Run in Browser",
            fallbackUrl: run.htmlUrl,
        }
    );
}

/**
 * Status-aware empty-state message. An in-progress run with no artifacts
 * usually just means "the workflow hasn't uploaded them yet" — we surface
 * that explicitly rather than a generic "no artifacts".
 */
async function reportNoArtifacts(run: WorkflowRunSummary): Promise<void> {
    const inProgress =
        run.conclusion === null &&
        run.status !== null &&
        run.status !== "completed";
    const message = inProgress
        ? `Run "${run.name ?? "workflow"}" #${run.runNumber} is still ${run.status ?? "in progress"} — no artifacts uploaded yet.`
        : `No non-expired artifacts found for run "${run.name ?? "workflow"}" #${run.runNumber}.`;
    const choice = await vscode.window.showWarningMessage(
        message,
        "Open Run in Browser"
    );
    if (choice === "Open Run in Browser") {
        await vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl));
    }
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

// Re-export so callers can detect whether a typed URL is a run URL without
// pulling in the parse module directly.
export { parseActionsRunUrl };
