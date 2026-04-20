import * as vscode from "vscode";
import type { PullRequestCoordinates } from "./parse-pr-url.js";

const GITHUB_API = "https://api.github.com";
const AUTH_SCOPES = ["repo"];

export interface PullRequestHead {
    readonly sha: string;
    readonly ref: string;
    readonly htmlUrl: string;
}

export interface WorkflowArtifact {
    readonly id: number;
    readonly name: string;
    readonly sizeInBytes: number;
    readonly expired: boolean;
    readonly createdAt: string;
    readonly runId: number;
}

export interface WorkflowRunSummary {
    readonly id: number;
    readonly name: string | null;
    readonly runNumber: number;
    readonly headSha: string;
    readonly htmlUrl: string;
    readonly createdAt: string;
}

/**
 * Thrown for HTTP failures the caller should react to differently — invalid
 * auth, missing PR, rate limits, or network errors. The `retryable` hint
 * drives whether the error UX offers a "Retry" button.
 */
export class GitHubApiError extends Error {
    public readonly status: number;
    public readonly retryable: boolean;

    constructor(status: number, message: string, retryable: boolean) {
        super(message);
        this.name = "GitHubApiError";
        this.status = status;
        this.retryable = retryable;
    }
}

/**
 * Resolves a VS Code GitHub auth session. Returns undefined if the user
 * cancels the consent prompt.
 */
export async function getGitHubSession(
    createIfNone: boolean
): Promise<vscode.AuthenticationSession | undefined> {
    try {
        return await vscode.authentication.getSession("github", AUTH_SCOPES, {
            createIfNone,
        });
    } catch (err) {
        if (err instanceof Error && /cancel/i.test(err.message)) {
            return undefined;
        }
        throw err;
    }
}

async function githubFetch<T>(
    token: string,
    path: string
): Promise<T> {
    const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
    let response: Response;
    try {
        response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "vscode-asciinema-extension",
            },
        });
    } catch (err) {
        throw new GitHubApiError(
            0,
            `Network error contacting GitHub: ${(err as Error).message}`,
            true
        );
    }

    if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        let message = `GitHub API ${response.status} ${response.statusText}`;
        try {
            const body = (await response.json()) as { message?: string };
            if (body.message) {
                message = `${message}: ${body.message}`;
            }
        } catch {
            // ignore JSON parse failures
        }
        throw new GitHubApiError(response.status, message, retryable);
    }
    return (await response.json()) as T;
}

/**
 * Fetches PR metadata and extracts the head commit info.
 */
export async function getPullRequestHead(
    token: string,
    coords: PullRequestCoordinates
): Promise<PullRequestHead> {
    const pr = await githubFetch<{
        head: { sha: string; ref: string };
        html_url: string;
    }>(token, `/repos/${coords.owner}/${coords.repo}/pulls/${coords.number}`);
    return {
        sha: pr.head.sha,
        ref: pr.head.ref,
        htmlUrl: pr.html_url,
    };
}

/**
 * Lists completed workflow runs for a specific head SHA, newest first.
 */
async function listCompletedRunsForSha(
    token: string,
    coords: PullRequestCoordinates,
    headSha: string
): Promise<WorkflowRunSummary[]> {
    const data = await githubFetch<{
        workflow_runs: Array<{
            id: number;
            name: string | null;
            run_number: number;
            head_sha: string;
            html_url: string;
            created_at: string;
        }>;
    }>(
        token,
        `/repos/${coords.owner}/${coords.repo}/actions/runs?head_sha=${headSha}&status=completed&per_page=50`
    );
    return data.workflow_runs.map((r) => ({
        id: r.id,
        name: r.name,
        runNumber: r.run_number,
        headSha: r.head_sha,
        htmlUrl: r.html_url,
        createdAt: r.created_at,
    }));
}

/**
 * Lists non-expired artifacts for a run.
 */
async function listArtifactsForRun(
    token: string,
    coords: PullRequestCoordinates,
    runId: number
): Promise<WorkflowArtifact[]> {
    const data = await githubFetch<{
        artifacts: Array<{
            id: number;
            name: string;
            size_in_bytes: number;
            expired: boolean;
            created_at: string;
            workflow_run: { id: number };
        }>;
    }>(
        token,
        `/repos/${coords.owner}/${coords.repo}/actions/runs/${runId}/artifacts?per_page=100`
    );
    return data.artifacts
        .filter((a) => !a.expired)
        .map((a) => ({
            id: a.id,
            name: a.name,
            sizeInBytes: a.size_in_bytes,
            expired: a.expired,
            createdAt: a.created_at,
            runId: a.workflow_run.id,
        }));
}

/**
 * Finds the most recent completed workflow run for the PR's head SHA that has
 * at least one non-expired artifact. Returns the run summary and its
 * artifacts, or undefined if no such run exists.
 *
 * Deliberately does NOT fall back to branch-based lookup — stale artifacts
 * from an older commit would be worse than a clean "no artifacts" error.
 */
export async function findRunWithArtifacts(
    token: string,
    coords: PullRequestCoordinates,
    headSha: string
): Promise<
    | { run: WorkflowRunSummary; artifacts: WorkflowArtifact[] }
    | undefined
> {
    const runs = await listCompletedRunsForSha(token, coords, headSha);
    for (const run of runs) {
        const artifacts = await listArtifactsForRun(token, coords, run.id);
        if (artifacts.length > 0) {
            return { run, artifacts };
        }
    }
    return undefined;
}

/**
 * Downloads an artifact zip. The `/zip` endpoint returns a 302 to a signed
 * URL; Node's fetch follows redirects and drops the Authorization header on
 * cross-origin redirects (desired — the signed URL self-authenticates).
 *
 * Enforces a compressed-size cap before returning the bytes.
 */
export async function downloadArtifactZip(
    token: string,
    coords: PullRequestCoordinates,
    artifactId: number,
    maxBytes: number
): Promise<Uint8Array> {
    let response: Response;
    try {
        response = await fetch(
            `${GITHUB_API}/repos/${coords.owner}/${coords.repo}/actions/artifacts/${artifactId}/zip`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "vscode-asciinema-extension",
                },
                redirect: "follow",
            }
        );
    } catch (err) {
        throw new GitHubApiError(
            0,
            `Network error downloading artifact: ${(err as Error).message}`,
            true
        );
    }

    if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        throw new GitHubApiError(
            response.status,
            `Artifact download failed: ${response.status} ${response.statusText}`,
            retryable
        );
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new GitHubApiError(
                0,
                `Artifact is ${Math.round(
                    contentLength / 1024 / 1024
                )} MB, exceeding the ${Math.round(
                    maxBytes / 1024 / 1024
                )} MB limit.`,
                false
            );
        }
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
        throw new GitHubApiError(
            0,
            `Artifact is ${Math.round(
                buffer.byteLength / 1024 / 1024
            )} MB, exceeding the ${Math.round(
                maxBytes / 1024 / 1024
            )} MB limit.`,
            false
        );
    }
    return new Uint8Array(buffer);
}
