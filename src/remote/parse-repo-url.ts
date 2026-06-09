import type { RepoCoordinates } from "./artifact-source.js";

/**
 * Parses a GitHub repository URL into owner/repo coordinates.
 *
 * Accepted forms:
 *   https://github.com/{owner}/{repo}
 *   https://github.com/{owner}/{repo}/pulls
 * plus optional trailing slash, query string, or hash.
 *
 * Returns `undefined` for non-repository URLs such as pull-request URLs,
 * workflow run URLs, issues, or any other path tails.
 */
const REPO_URL_PATTERN =
    /^https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:\/pulls)?\/?(?:[?#].*)?$/i;

export function parseRepositoryUrl(
    raw: string
): RepoCoordinates | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }
    const trimmed = raw.trim();
    const match = REPO_URL_PATTERN.exec(trimmed);
    if (!match) {
        return undefined;
    }
    const [, owner, repo] = match;
    return { owner, repo };
}
