import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRepositoryUrl } from "../parse-repo-url.js";

describe("parseRepositoryUrl", () => {
    it("parses canonical repository URL", () => {
        const got = parseRepositoryUrl("https://github.com/octocat/hello-world");
        assert.deepEqual(got, { owner: "octocat", repo: "hello-world" });
    });

    it("accepts /pulls URL", () => {
        const got = parseRepositoryUrl(
            "https://github.com/octocat/hello-world/pulls"
        );
        assert.deepEqual(got, { owner: "octocat", repo: "hello-world" });
    });

    it("accepts trailing slash, query, and hash", () => {
        const slash = parseRepositoryUrl(
            "https://github.com/octocat/hello-world/"
        );
        assert.deepEqual(slash, { owner: "octocat", repo: "hello-world" });

        const query = parseRepositoryUrl(
            "https://github.com/octocat/hello-world/pulls?q=is%3Aopen"
        );
        assert.deepEqual(query, { owner: "octocat", repo: "hello-world" });

        const hash = parseRepositoryUrl(
            "https://github.com/octocat/hello-world#readme"
        );
        assert.deepEqual(hash, { owner: "octocat", repo: "hello-world" });
    });

    it("rejects PR and Actions run URLs", () => {
        assert.equal(
            parseRepositoryUrl("https://github.com/octocat/hello-world/pull/42"),
            undefined
        );
        assert.equal(
            parseRepositoryUrl(
                "https://github.com/octocat/hello-world/actions/runs/123"
            ),
            undefined
        );
    });

    it("rejects non-github host and unsupported tails", () => {
        assert.equal(
            parseRepositoryUrl("https://gitlab.com/octocat/hello-world"),
            undefined
        );
        assert.equal(
            parseRepositoryUrl("https://github.com/octocat/hello-world/issues"),
            undefined
        );
    });

    it("rejects non-string input", () => {
        assert.equal(parseRepositoryUrl(undefined as never), undefined);
        assert.equal(parseRepositoryUrl(null as never), undefined);
        assert.equal(parseRepositoryUrl(42 as never), undefined);
    });

    it("trims whitespace", () => {
        const got = parseRepositoryUrl(
            "  https://github.com/octocat/hello-world  "
        );
        assert.deepEqual(got, { owner: "octocat", repo: "hello-world" });
    });
});
