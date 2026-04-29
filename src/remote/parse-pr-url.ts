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
 *
 * The owner/repo character classes mirror GitHub's actual rules so injection
 * characters (`?`, `#`, `&`, whitespace, etc.) cannot slip through into the
 * downstream API URL path:
 *   - owner: alphanumerics, hyphens (1-39 chars per GitHub's documented limit)
 *   - repo:  alphanumerics, hyphens, underscores, periods (1-100 chars)
 */
export interface PullRequestCoordinates {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
}

const PR_URL_PATTERN =
    /^https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d+)(?:\/[\w-]+)?\/?(?:[?#].*)?$/i;

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
