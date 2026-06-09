import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDeepLink } from "../deep-link.js";

describe("parseDeepLink", () => {
    it("accepts an encoded pull request URL", () => {
        const url = "https://github.com/octocat/hello-world/pull/42";
        const result = parseDeepLink(
            "/open",
            `url=${encodeURIComponent(url)}`
        );
        assert.deepEqual(result, { ok: true, target: "pullRequest", url });
    });

    it("accepts an encoded Actions run URL", () => {
        const url =
            "https://github.com/octocat/hello-world/actions/runs/123456";
        const result = parseDeepLink(
            "/open",
            `url=${encodeURIComponent(url)}`
        );
        assert.deepEqual(result, { ok: true, target: "actionsRun", url });
    });

    it("accepts an encoded repository URL", () => {
        const url = "https://github.com/octocat/hello-world";
        const result = parseDeepLink(
            "/open",
            `url=${encodeURIComponent(url)}`
        );
        assert.deepEqual(result, { ok: true, target: "repository", url });
    });

    it("allows VS Code window routing metadata", () => {
        const url = "https://github.com/octocat/hello-world/pull/42";
        const result = parseDeepLink(
            "/open",
            `url=${encodeURIComponent(url)}&windowId=14`
        );
        assert.deepEqual(result, { ok: true, target: "pullRequest", url });
    });

    it("preserves encoded query and hash parts inside the GitHub URL", () => {
        const url =
            "https://github.com/octocat/hello-world/pull/42?plain=1#discussion";
        const result = parseDeepLink(
            "/open",
            `url=${encodeURIComponent(url)}`
        );
        assert.deepEqual(result, { ok: true, target: "pullRequest", url });
    });

    it("rejects unsupported paths", () => {
        const result = parseDeepLink(
            "/run",
            `url=${encodeURIComponent(
                "https://github.com/octocat/hello-world/pull/42"
            )}`
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, "unsupportedPath");
        }
    });

    it("rejects missing or duplicated url parameters", () => {
        const missing = parseDeepLink("/open", "");
        assert.equal(missing.ok, false);
        if (!missing.ok) {
            assert.equal(missing.code, "missingUrl");
        }

        const duplicated = parseDeepLink(
            "/open",
            "url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1&url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F2"
        );
        assert.equal(duplicated.ok, false);
        if (!duplicated.ok) {
            assert.equal(duplicated.code, "missingUrl");
        }
    });

    it("rejects unsupported query parameters", () => {
        const result = parseDeepLink(
            "/open",
            "url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1&command=workbench.action.reloadWindow"
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, "unsupportedQuery");
        }
    });

    it("rejects non-GitHub and unsupported GitHub URLs", () => {
        const nonGitHub = parseDeepLink(
            "/open",
            "url=https%3A%2F%2Fexample.com%2Fa%2Fb%2Fpull%2F1"
        );
        assert.equal(nonGitHub.ok, false);
        if (!nonGitHub.ok) {
            assert.equal(nonGitHub.code, "invalidUrl");
        }

        const issue = parseDeepLink(
            "/open",
            "url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fissues%2F1"
        );
        assert.equal(issue.ok, false);
        if (!issue.ok) {
            assert.equal(issue.code, "invalidUrl");
        }
    });
});
