/**
 * Parses a GitHub pull request URL into its owner/repo/number components.
 *
 * Accepts canonical form and common tail suffixes users tend to copy:
 *   https://github.com/{owner}/{repo}/pull/{number}
 *   https://github.com/{owner}/{repo}/pull/{number}/files
 *   https://github.com/{owner}/{repo}/pull/{number}/commits
 *   trailing slash, anchors, query strings
 *
 * Returns `undefined` on anything that isn't a plausible PR URL.
 */
export interface PullRequestCoordinates {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
}

const PR_URL_PATTERN =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:\/[\w-]+)?\/?(?:[?#].*)?$/i;

export function parsePullRequestUrl(
    raw: string
): PullRequestCoordinates | undefined {
    if (typeof raw !== "string") {
        return undefined;
    }
    const trimmed = raw.trim();
    const match = PR_URL_PATTERN.exec(trimmed);
    if (!match) {
        return undefined;
    }
    const [, owner, repo, numberText] = match;
    const number = Number(numberText);
    if (!Number.isInteger(number) || number <= 0) {
        return undefined;
    }
    return { owner, repo, number };
}
