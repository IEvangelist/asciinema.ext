import * as vscode from "vscode";
import {
    parsePullRequestUrl,
    type PullRequestCoordinates,
} from "./parse-pr-url.js";
import {
    GitHubApiError,
    downloadArtifactZip,
    findRunWithArtifacts,
    getGitHubSession,
    getPullRequestHead,
    type WorkflowArtifact,
    type WorkflowRunSummary,
} from "./github-client.js";
import {
    DEFAULT_LIMITS,
    ZipLimitError,
    extractCastEntries,
    type CastEntry,
} from "./artifact-zip.js";
import { writeTempCast } from "./temp-storage.js";

const MAX_COMPRESSED_ARTIFACT_BYTES = 50 * 1024 * 1024;

export async function openFromPullRequestCommand(
    context: vscode.ExtensionContext
): Promise<void> {
    const rawUrl = await vscode.window.showInputBox({
        title: "Asciinema — Open from GitHub Pull Request",
        prompt: "Paste a GitHub pull request URL",
        placeHolder: "https://github.com/owner/repo/pull/123",
        ignoreFocusOut: true,
        validateInput: (value) =>
            !value || parsePullRequestUrl(value)
                ? undefined
                : "Not a recognized GitHub pull request URL",
    });
    if (!rawUrl) {
        return;
    }

    const coords = parsePullRequestUrl(rawUrl);
    if (!coords) {
        await vscode.window.showErrorMessage(
            "That doesn't look like a GitHub pull request URL."
        );
        return;
    }

    await runFlow(context, coords);
}

async function runFlow(
    context: vscode.ExtensionContext,
    coords: PullRequestCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;

    let head: Awaited<ReturnType<typeof getPullRequestHead>>;
    try {
        head = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Asciinema — Looking up ${coords.owner}/${coords.repo}#${coords.number}`,
            },
            () => getPullRequestHead(token, coords)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: `Couldn't access pull request ${coords.owner}/${coords.repo}#${coords.number}.`,
            prUrl: `https://github.com/${coords.owner}/${coords.repo}/pull/${coords.number}`,
            retry: () => runFlow(context, coords),
        });
        return;
    }

    let runAndArtifacts:
        | { run: WorkflowRunSummary; artifacts: WorkflowArtifact[] }
        | undefined;
    try {
        runAndArtifacts = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Asciinema — Finding CI run with artifacts",
            },
            () => findRunWithArtifacts(token, coords, head.sha)
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to query workflow runs.",
            prUrl: head.htmlUrl,
            retry: () => runFlow(context, coords),
        });
        return;
    }

    if (!runAndArtifacts) {
        const choice = await vscode.window.showErrorMessage(
            `No completed workflow run with artifacts found for commit ${head.sha.slice(
                0,
                7
            )} on PR #${coords.number}.`,
            "Open PR in Browser"
        );
        if (choice === "Open PR in Browser") {
            await vscode.env.openExternal(vscode.Uri.parse(head.htmlUrl));
        }
        return;
    }

    const chosenArtifact = await pickArtifact(runAndArtifacts.artifacts);
    if (!chosenArtifact) {
        return;
    }

    let zipBytes: Uint8Array;
    try {
        zipBytes = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Asciinema — Downloading artifact "${chosenArtifact.name}"`,
            },
            () =>
                downloadArtifactZip(
                    token,
                    coords,
                    chosenArtifact.id,
                    MAX_COMPRESSED_ARTIFACT_BYTES
                )
        );
    } catch (err) {
        await handleApiError(err, {
            notFoundMessage: "Failed to download the artifact zip.",
            prUrl: head.htmlUrl,
            retry: () => runFlow(context, coords),
        });
        return;
    }

    let castEntries: CastEntry[];
    try {
        castEntries = await extractCastEntries(zipBytes, DEFAULT_LIMITS);
    } catch (err) {
        if (err instanceof ZipLimitError) {
            await vscode.window.showErrorMessage(err.message);
        } else {
            await vscode.window.showErrorMessage(
                `Couldn't read artifact zip: ${(err as Error).message}`
            );
        }
        return;
    }

    if (castEntries.length === 0) {
        await vscode.window.showErrorMessage(
            `Artifact "${chosenArtifact.name}" doesn't contain any .cast files.`
        );
        return;
    }

    const chosenCast = await pickCastEntry(castEntries);
    if (!chosenCast) {
        return;
    }

    const fileUri = await writeTempCast(
        context,
        chosenCast.path,
        chosenCast.bytes
    );
    await vscode.commands.executeCommand(
        "vscode.openWith",
        fileUri,
        "asciinema.castPreview"
    );
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

async function pickArtifact(
    artifacts: WorkflowArtifact[]
): Promise<WorkflowArtifact | undefined> {
    if (artifacts.length === 1) {
        return artifacts[0];
    }
    const items = artifacts.map((a) => ({
        label: a.name,
        description: `${formatSize(a.sizeInBytes)} · ${formatDate(a.createdAt)}`,
        artifact: a,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: "Select an artifact to download",
        matchOnDescription: true,
        ignoreFocusOut: true,
    });
    return picked?.artifact;
}

async function pickCastEntry(
    entries: CastEntry[]
): Promise<CastEntry | undefined> {
    if (entries.length === 1) {
        return entries[0];
    }
    const items = entries.map((e) => ({
        label: e.path,
        description: formatSize(e.bytes.byteLength),
        entry: e,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: "Select a .cast file to open",
        matchOnDescription: true,
        ignoreFocusOut: true,
    });
    return picked?.entry;
}

interface ApiErrorContext {
    readonly notFoundMessage: string;
    readonly prUrl: string;
    readonly retry: () => Promise<void> | void;
}

async function handleApiError(
    err: unknown,
    ctx: ApiErrorContext
): Promise<void> {
    if (err instanceof GitHubApiError) {
        if (err.status === 401 || err.status === 403 || err.status === 404) {
            const choice = await vscode.window.showErrorMessage(
                `${ctx.notFoundMessage} ${err.message}`,
                "Open PR in Browser"
            );
            if (choice === "Open PR in Browser") {
                await vscode.env.openExternal(vscode.Uri.parse(ctx.prUrl));
            }
            return;
        }
        if (err.retryable) {
            const choice = await vscode.window.showErrorMessage(
                err.message,
                "Retry"
            );
            if (choice === "Retry") {
                await ctx.retry();
            }
            return;
        }
        await vscode.window.showErrorMessage(err.message);
        return;
    }
    await vscode.window.showErrorMessage(
        `Unexpected error: ${(err as Error).message}`
    );
}

function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return iso;
    }
}
