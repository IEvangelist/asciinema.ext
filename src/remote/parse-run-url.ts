/**
 * Parses a GitHub Actions workflow run URL into its owner/repo/runId components.
 *
 * Accepts canonical form and common tail suffixes users tend to copy from the
 * web UI:
 *   https://github.com/{owner}/{repo}/actions/runs/{runId}
 *   https://github.com/{owner}/{repo}/actions/runs/{runId}/job/{jobId}
 *   https://github.com/{owner}/{repo}/actions/runs/{runId}/jobs/{jobId}
 *   https://github.com/{owner}/{repo}/actions/runs/{runId}/attempts/{attempt}
 *   https://github.com/{owner}/{repo}/actions/runs/{runId}/workflow
 *   trailing slash, anchors, query strings
 *
 * Returns `undefined` on anything that isn't a plausible run URL.
 *
 * The owner/repo character classes mirror GitHub's documented rules so
 * injection characters (`?`, `#`, `&`, whitespace, etc.) cannot slip through
 * into downstream API path segments:
 *   - owner: alphanumerics, hyphens (1-39 chars per GitHub's documented limit)
 *   - repo:  alphanumerics, hyphens, underscores, periods (1-100 chars)
 *
 * Note: tail segments like `/attempts/N` are accepted as URL conveniences but
 * deliberately ignored — we always fetch the run's current artifacts. If you
 * need attempt-specific behavior in the future, capture the suffix here.
 */
export interface ActionsRunCoordinates {
    readonly owner: string;
    readonly repo: string;
    readonly runId: number;
}

const RUN_URL_PATTERN =
    /^https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d+)(?:\/[A-Za-z0-9._\-/]+)?\/?(?:[?#].*)?$/i;

export function parseActionsRunUrl(
    raw: string
): ActionsRunCoordinates | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }
    const trimmed = raw.trim();
    const match = RUN_URL_PATTERN.exec(trimmed);
    if (!match) {
        return undefined;
    }
    const [, owner, repo, runIdText] = match;
    const runId = Number(runIdText);
    if (!Number.isInteger(runId) || runId <= 0) {
        return undefined;
    }
    return { owner, repo, runId };
}
