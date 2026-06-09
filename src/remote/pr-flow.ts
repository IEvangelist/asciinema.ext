import * as vscode from "vscode";
import type { PullRequestCoordinates } from "./parse-pr-url.js";
import {
    findRunWithArtifacts,
    getGitHubSession,
    getPullRequestHead,
} from "./github-client.js";
import { fromPullRequest, pullRequestUrl } from "./artifact-source.js";
import {
    handleApiError,
    pickAndOpenArtifact,
} from "./download-and-open.js";
import { runActionsRunFlow } from "./actions-run-flow.js";
import { pickActiveWorkflowRunForPullRequest } from "./pending-pr-runs.js";
import {
    pickPaletteAction,
    withPaletteProgress,
} from "./quick-input.js";

export async function runPrFlow(
    context: vscode.ExtensionContext,
    coords: PullRequestCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;
    const prUrl = pullRequestUrl(coords);

    let head: Awaited<ReturnType<typeof getPullRequestHead>>;
    try {
        head = await withPaletteProgress(
            {
                title: `GitHub Artifacts — Looking up ${coords.owner}/${coords.repo}#${coords.number}`,
                placeholder: "Looking up pull request metadata...",
                initialMessage: "Resolving PR head commit",
            },
            () => getPullRequestHead(token, coords)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: `Couldn't access pull request ${coords.owner}/${coords.repo}#${coords.number}.`,
            fallbackLabel: "Open PR in Browser",
            fallbackUrl: prUrl,
            retry: () => runPrFlow(context, coords),
        });
        return;
    }

    let runAndArtifacts:
        | Awaited<ReturnType<typeof findRunWithArtifacts>>
        | undefined;
    try {
        runAndArtifacts = await withPaletteProgress(
            {
                title: "GitHub Artifacts — Finding CI run with artifacts",
                placeholder: "Checking completed workflow runs...",
                initialMessage: "Looking for non-expired artifacts",
            },
            () => findRunWithArtifacts(token, coords, head.sha)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to query workflow runs.",
            fallbackLabel: "Open PR in Browser",
            fallbackUrl: head.htmlUrl,
            retry: () => runPrFlow(context, coords),
        });
        return;
    }

    if (!runAndArtifacts) {
        const selectedRun = await pickActiveWorkflowRunForPullRequest(
            token,
            coords,
            head
        );
        if (!selectedRun) {
            return;
        }
        await runActionsRunFlow(
            context,
            {
                owner: coords.owner,
                repo: coords.repo,
                runId: selectedRun.id,
            },
            {
                initialRun: selectedRun,
                source: fromPullRequest(coords),
                waitIfNotReady: true,
            }
        );
        return;
    }

    const { run, artifacts } = runAndArtifacts;
    await pickAndOpenArtifact(
        context,
        fromPullRequest(coords),
        run,
        artifacts,
        {
            fallbackLabel: "Open PR in Browser",
            fallbackUrl: head.htmlUrl,
        }
    );
}

export async function acquireSession(): Promise<
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
    const choice = await pickPaletteAction(
        [
            {
                label: "$(sign-in)  Sign in",
                description: "Use VS Code's GitHub authentication",
                value: "sign-in",
            },
            {
                label: "$(close)  Cancel",
                value: "cancel",
            },
        ],
        {
            title: "GitHub Artifacts — sign in required",
            message: "GitHub sign-in is required to download CI artifacts.",
        }
    );
    if (choice === "sign-in") {
        return await getGitHubSession(true);
    }
    return undefined;
}
