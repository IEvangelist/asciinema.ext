import * as vscode from "vscode";
import type { PullRequestCoordinates } from "./parse-pr-url.js";
import type { RepoCoordinates } from "./artifact-source.js";

const GITHUB_API = "https://api.github.com";
const AUTH_SCOPES = ["repo"];

/**
 * Builds a `/repos/{owner}/{repo}` API path with each segment percent-encoded.
 *
 * Defense-in-depth: while the URL parsers already constrain owner/repo to
 * GitHub's documented character set, encoding here ensures any future caller
 * passing user-supplied values cannot inject path or query segments into the
 * request URL.
 */
function repoApiPath(repo: RepoCoordinates): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

export interface PullRequestHead {
    readonly sha: string;
    readonly ref: string;
    readonly htmlUrl: string;
}

export interface PullRequestSummary {
    readonly number: number;
    readonly title: string;
    readonly state: string;
    readonly draft: boolean;
    readonly author: string | null;
    readonly htmlUrl: string;
    readonly updatedAt: string;
    readonly headSha: string;
    readonly headRef: string;
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
    readonly headBranch: string | null;
    readonly actor: string | null;
    readonly conclusion: string | null;
    readonly status: string | null;
    readonly htmlUrl: string;
    readonly createdAt: string;
    readonly updatedAt?: string;
}

export interface WorkflowJobSummary {
    readonly id: number;
    readonly name: string;
    readonly status: string | null;
    readonly conclusion: string | null;
    readonly htmlUrl: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
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
    }>(token, `${repoApiPath(coords)}/pulls/${encodeURIComponent(String(coords.number))}`);
    return {
        sha: pr.head.sha,
        ref: pr.head.ref,
        htmlUrl: pr.html_url,
    };
}

export interface ListWorkflowRunsForShaOptions {
    readonly status?: string;
    readonly perPage?: number;
}

export interface ListPullRequestsOptions {
    readonly state?: "open" | "closed" | "all";
    readonly perPage?: number;
}

/**
 * Lists pull requests for a repository, newest-updated first.
 */
export async function listPullRequests(
    token: string,
    repo: RepoCoordinates,
    options: ListPullRequestsOptions = {}
): Promise<PullRequestSummary[]> {
    const params = new URLSearchParams({
        state: options.state ?? "open",
        sort: "updated",
        direction: "desc",
        per_page: String(options.perPage ?? 30),
    });
    const data = await githubFetch<
        Array<{
            number: number;
            title: string;
            state: string;
            draft?: boolean | null;
            user?: { login?: string } | null;
            html_url: string;
            updated_at: string;
            head: { sha: string; ref: string };
        }>
    >(token, `${repoApiPath(repo)}/pulls?${params.toString()}`);
    return data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: !!pr.draft,
        author: pr.user?.login ?? null,
        htmlUrl: pr.html_url,
        updatedAt: pr.updated_at,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
    }));
}

/**
 * Lists workflow runs for a specific head SHA, newest first. Pass a GitHub
 * Actions `status` value to constrain the API query; omit it to fetch every
 * status and filter client-side.
 */
export async function listWorkflowRunsForSha(
    token: string,
    repo: RepoCoordinates,
    headSha: string,
    options: ListWorkflowRunsForShaOptions = {}
): Promise<WorkflowRunSummary[]> {
    const params = new URLSearchParams({
        head_sha: headSha,
        per_page: String(options.perPage ?? 50),
    });
    if (options.status) {
        params.set("status", options.status);
    }
    const data = await githubFetch<{
        workflow_runs: Array<{
            id: number;
            name: string | null;
            run_number: number;
            head_sha: string;
            head_branch: string | null;
            actor?: { login?: string } | null;
            triggering_actor?: { login?: string } | null;
            conclusion: string | null;
            status: string | null;
            html_url: string;
            created_at: string;
            updated_at?: string;
        }>;
    }>(
        token,
        `${repoApiPath(repo)}/actions/runs?${params.toString()}`
    );
    return data.workflow_runs.map(mapWorkflowRun);
}

function mapWorkflowRun(r: {
    id: number;
    name: string | null;
    run_number: number;
    head_sha: string;
    head_branch: string | null;
    actor?: { login?: string } | null;
    triggering_actor?: { login?: string } | null;
    conclusion: string | null;
    status: string | null;
    html_url: string;
    created_at: string;
    updated_at?: string;
}): WorkflowRunSummary {
    return {
        id: r.id,
        name: r.name,
        runNumber: r.run_number,
        headSha: r.head_sha,
        headBranch: r.head_branch,
        actor: r.actor?.login ?? r.triggering_actor?.login ?? null,
        conclusion: r.conclusion,
        status: r.status,
        htmlUrl: r.html_url,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/**
 * Fetches a single workflow run by id.
 */
export async function getWorkflowRunById(
    token: string,
    repo: RepoCoordinates,
    runId: number
): Promise<WorkflowRunSummary> {
    const r = await githubFetch<{
        id: number;
        name: string | null;
        run_number: number;
        head_sha: string;
        head_branch: string | null;
        actor?: { login?: string } | null;
        triggering_actor?: { login?: string } | null;
        conclusion: string | null;
        status: string | null;
        html_url: string;
        created_at: string;
        updated_at?: string;
    }>(
        token,
        `${repoApiPath(repo)}/actions/runs/${encodeURIComponent(String(runId))}`
    );
    return mapWorkflowRun(r);
}

function mapWorkflowJob(j: {
    id: number;
    name: string;
    status: string | null;
    conclusion: string | null;
    html_url: string;
    started_at: string | null;
    completed_at: string | null;
}): WorkflowJobSummary {
    return {
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        htmlUrl: j.html_url,
        startedAt: j.started_at,
        completedAt: j.completed_at,
    };
}

/**
 * Lists jobs for a workflow run. Paginates so large matrix runs show every
 * job status in pending-run pickers and wait progress messages.
 */
export async function listJobsForRun(
    token: string,
    repo: RepoCoordinates,
    runId: number
): Promise<WorkflowJobSummary[]> {
    const collected: WorkflowJobSummary[] = [];
    const PER_PAGE = 100;
    const MAX_PAGES = 20;
    let page = 1;
    while (page <= MAX_PAGES) {
        const data = await githubFetch<{
            total_count: number;
            jobs: Array<{
                id: number;
                name: string;
                status: string | null;
                conclusion: string | null;
                html_url: string;
                started_at: string | null;
                completed_at: string | null;
            }>;
        }>(
            token,
            `${repoApiPath(repo)}/actions/runs/${encodeURIComponent(String(runId))}/jobs?filter=latest&per_page=${PER_PAGE}&page=${page}`
        );
        collected.push(...data.jobs.map(mapWorkflowJob));
        if (data.jobs.length < PER_PAGE || collected.length >= data.total_count) {
            break;
        }
        page++;
    }
    return collected;
}

/**
 * Lists non-expired artifacts for a run. Paginates through all pages
 * (`per_page=100`) so callers see every artifact on a run.
 */
export async function listArtifactsForRun(
    token: string,
    repo: RepoCoordinates,
    runId: number
): Promise<WorkflowArtifact[]> {
    const collected: WorkflowArtifact[] = [];
    const PER_PAGE = 100;
    const MAX_PAGES = 50; // hard cap — 5,000 artifacts is way past anything sane
    let page = 1;
    while (page <= MAX_PAGES) {
        const data = await githubFetch<{
            total_count: number;
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
            `${repoApiPath(repo)}/actions/runs/${encodeURIComponent(String(runId))}/artifacts?per_page=${PER_PAGE}&page=${page}`
        );
        for (const a of data.artifacts) {
            if (a.expired) {
                continue;
            }
            collected.push({
                id: a.id,
                name: a.name,
                sizeInBytes: a.size_in_bytes,
                expired: a.expired,
                createdAt: a.created_at,
                runId: a.workflow_run.id,
            });
        }
        if (
            data.artifacts.length < PER_PAGE ||
            collected.length >= data.total_count
        ) {
            break;
        }
        page++;
    }
    return collected;
}

/**
 * Finds the most recent completed workflow run for the head SHA that has
 * at least one non-expired artifact. Returns the run summary and its
 * artifacts, or undefined if no such run exists.
 *
 * Deliberately does NOT fall back to branch-based lookup — stale artifacts
 * from an older commit would be worse than a clean "no artifacts" error.
 */
export async function findRunWithArtifacts(
    token: string,
    repo: RepoCoordinates,
    headSha: string
): Promise<
    | { run: WorkflowRunSummary; artifacts: WorkflowArtifact[] }
    | undefined
> {
    const runs = await listWorkflowRunsForSha(token, repo, headSha, {
        status: "completed",
    });
    for (const run of runs) {
        const artifacts = await listArtifactsForRun(token, repo, run.id);
        if (artifacts.length > 0) {
            return { run, artifacts };
        }
    }
    return undefined;
}

export interface DownloadProgress {
    /** Bytes received so far. */
    readonly received: number;
    /**
     * Total bytes expected, when the server provided a `Content-Length`
     * header. Undefined for chunked/unknown responses.
     */
    readonly total?: number;
}

/**
 * Downloads an artifact zip. The `/zip` endpoint returns a 302 to a signed
 * URL; Node's fetch follows redirects and drops the Authorization header on
 * cross-origin redirects (desired — the signed URL self-authenticates).
 *
 * Enforces a compressed-size cap before returning the bytes. Reads the body
 * incrementally via `ReadableStream` so callers can report fine-grained
 * progress.
 */
export async function downloadArtifactZip(
    token: string,
    repo: RepoCoordinates,
    artifactId: number,
    maxBytes: number,
    onProgress?: (p: DownloadProgress) => void,
    signal?: AbortSignal
): Promise<Uint8Array> {
    if (signal?.aborted) {
        throw createDownloadAbortError();
    }
    let response: Response;
    try {
        response = await fetch(
            `${GITHUB_API}${repoApiPath(repo)}/actions/artifacts/${encodeURIComponent(String(artifactId))}/zip`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "vscode-asciinema-extension",
                },
                redirect: "follow",
                signal,
            }
        );
    } catch (err) {
        if (isFetchAbortError(err)) {
            throw createDownloadAbortError();
        }
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
    let total: number | undefined;
    if (contentLengthHeader) {
        const parsed = Number(contentLengthHeader);
        if (Number.isFinite(parsed) && parsed >= 0) {
            total = parsed;
            if (parsed > maxBytes) {
                throw new GitHubApiError(
                    0,
                    `Artifact is ${Math.round(
                        parsed / 1024 / 1024
                    )} MB, exceeding the ${Math.round(
                        maxBytes / 1024 / 1024
                    )} MB limit.`,
                    false
                );
            }
        }
    }

    if (!response.body) {
        // Fall back to bulk-read when body streaming isn't supported.
        let buffer: ArrayBuffer;
        try {
            buffer = await response.arrayBuffer();
        } catch (err) {
            if (isFetchAbortError(err)) {
                throw createDownloadAbortError();
            }
            throw err;
        }
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
        onProgress?.({ received: buffer.byteLength, total });
        return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    onProgress?.({ received: 0, total });

    while (true) {
        const { done, value } = await reader.read().catch((err) => {
            if (isFetchAbortError(err)) {
                throw createDownloadAbortError();
            }
            throw err;
        });
        if (done) {
            break;
        }
        if (value) {
            received += value.byteLength;
            if (received > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    // ignore
                }
                throw new GitHubApiError(
                    0,
                    `Artifact exceeds the ${Math.round(
                        maxBytes / 1024 / 1024
                    )} MB limit during download.`,
                    false
                );
            }
            chunks.push(value);
            onProgress?.({ received, total });
        }
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function isFetchAbortError(err: unknown): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    const name = (err as { name?: unknown }).name;
    return name === "AbortError";
}

function createDownloadAbortError(): Error {
    const err = new Error("Download cancelled.");
    err.name = "AbortError";
    return err;
}
