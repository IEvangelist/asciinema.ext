import { parsePullRequestUrl } from "./parse-pr-url.js";
import { parseActionsRunUrl } from "./parse-run-url.js";
import { parseRepositoryUrl } from "./parse-repo-url.js";

export type DeepLinkTarget = "pullRequest" | "actionsRun" | "repository";

export type DeepLinkErrorCode =
    | "unsupportedPath"
    | "unsupportedQuery"
    | "missingUrl"
    | "invalidUrl";

export type DeepLinkParseResult =
    | {
          readonly ok: true;
          readonly target: DeepLinkTarget;
          readonly url: string;
      }
    | {
          readonly ok: false;
          readonly code: DeepLinkErrorCode;
          readonly message: string;
      };

const SUPPORTED_PATH = "/open";
const ALLOWED_QUERY_KEYS = new Set(["url", "windowId"]);

export function parseDeepLink(
    path: string,
    query: string
): DeepLinkParseResult {
    if (normalizePath(path) !== SUPPORTED_PATH) {
        return {
            ok: false,
            code: "unsupportedPath",
            message: `Unsupported deep link path. Expected ${SUPPORTED_PATH}.`,
        };
    }

    const params = new URLSearchParams(query);
    const unknownKeys = [...new Set(params.keys())].filter(
        (key) => !ALLOWED_QUERY_KEYS.has(key)
    );
    if (unknownKeys.length > 0) {
        return {
            ok: false,
            code: "unsupportedQuery",
            message: `Unsupported deep link parameter: ${unknownKeys[0]}.`,
        };
    }

    const urls = params.getAll("url");
    if (urls.length !== 1 || urls[0].trim().length === 0) {
        return {
            ok: false,
            code: "missingUrl",
            message: "Deep link must include exactly one url parameter.",
        };
    }

    const url = urls[0].trim();
    if (parsePullRequestUrl(url)) {
        return { ok: true, target: "pullRequest", url };
    }
    if (parseActionsRunUrl(url)) {
        return { ok: true, target: "actionsRun", url };
    }
    if (parseRepositoryUrl(url)) {
        return { ok: true, target: "repository", url };
    }

    return {
        ok: false,
        code: "invalidUrl",
        message:
            "Deep link URL must be a GitHub pull request, Actions run, or repository URL.",
    };
}

function normalizePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed.startsWith("/")) {
        return trimmed;
    }
    return `/${trimmed}`;
}
