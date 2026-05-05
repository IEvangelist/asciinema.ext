import type { PullRequestCoordinates } from "./parse-pr-url.js";
import type { ActionsRunCoordinates } from "./parse-run-url.js";

/**
 * Just the owner+repo subset shared by both PR and run-based artifact sources.
 * Most code (GitHub API helpers, handler context, download pipeline) only
 * needs this — number/runId are PR/run-specific and live on `ArtifactSource`.
 */
export interface RepoCoordinates {
    readonly owner: string;
    readonly repo: string;
}

/**
 * Discriminated union describing where an artifact was discovered. Stored on
 * `RecentArtifact` so the recents UI knows whether to surface a PR link, a
 * run link, or both, and so users see the right copy ("PR #123" vs "run id").
 */
export type ArtifactSource =
    | { readonly kind: "pr"; readonly coords: PullRequestCoordinates }
    | { readonly kind: "run"; readonly coords: RepoCoordinates };

export function repoOf(source: ArtifactSource): RepoCoordinates {
    return { owner: source.coords.owner, repo: source.coords.repo };
}

export function fromPullRequest(
    coords: PullRequestCoordinates
): ArtifactSource {
    return { kind: "pr", coords };
}

export function fromActionsRun(
    coords: ActionsRunCoordinates
): ArtifactSource {
    return { kind: "run", coords: { owner: coords.owner, repo: coords.repo } };
}

export function pullRequestUrl(
    coords: PullRequestCoordinates
): string {
    return `https://github.com/${coords.owner}/${coords.repo}/pull/${coords.number}`;
}
