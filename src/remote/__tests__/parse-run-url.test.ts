import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseActionsRunUrl } from "../parse-run-url.js";

describe("parseActionsRunUrl", () => {
    it("parses canonical run URL", () => {
        const got = parseActionsRunUrl(
            "https://github.com/IEvangelist/resource-translator/actions/runs/25387480665"
        );
        assert.deepEqual(got, {
            owner: "IEvangelist",
            repo: "resource-translator",
            runId: 25387480665,
        });
    });

    it("accepts trailing slash", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42/"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("accepts query string", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42?check_suite_focus=true"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("accepts hash fragment", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42#step:1:1"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("accepts /job/{id} tail", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42/job/123"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("accepts /jobs/{id} tail", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42/jobs/123"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("accepts /attempts/N tail (but ignores attempt number)", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42/attempts/3"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("accepts /workflow tail", () => {
        const got = parseActionsRunUrl(
            "https://github.com/octocat/hello-world/actions/runs/42/workflow"
        );
        assert.deepEqual(got, {
            owner: "octocat",
            repo: "hello-world",
            runId: 42,
        });
    });

    it("rejects non-github host", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://gitlab.com/owner/repo/actions/runs/42"
            ),
            undefined
        );
    });

    it("rejects PR URLs", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello-world/pull/123"
            ),
            undefined
        );
    });

    it("rejects /actions/workflows/ URLs", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello-world/actions/workflows/ci.yml"
            ),
            undefined
        );
    });

    it("rejects runId of 0", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello-world/actions/runs/0"
            ),
            undefined
        );
    });

    it("rejects negative runId", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello-world/actions/runs/-1"
            ),
            undefined
        );
    });

    it("rejects non-numeric runId", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello-world/actions/runs/abc"
            ),
            undefined
        );
    });

    it("rejects injection characters in owner/repo", () => {
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat?evil=1/hello-world/actions/runs/42"
            ),
            undefined
        );
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello world/actions/runs/42"
            ),
            undefined
        );
        assert.equal(
            parseActionsRunUrl(
                "https://github.com/octocat/hello#evil/actions/runs/42"
            ),
            undefined
        );
    });

    it("rejects non-string input", () => {
        assert.equal(parseActionsRunUrl(undefined as never), undefined);
        assert.equal(parseActionsRunUrl(null as never), undefined);
        assert.equal(parseActionsRunUrl(42 as never), undefined);
    });

    it("trims whitespace", () => {
        const got = parseActionsRunUrl(
            "  https://github.com/owner/repo/actions/runs/42  "
        );
        assert.deepEqual(got, { owner: "owner", repo: "repo", runId: 42 });
    });

    it("accepts http (legacy)", () => {
        const got = parseActionsRunUrl(
            "http://github.com/owner/repo/actions/runs/42"
        );
        assert.deepEqual(got, { owner: "owner", repo: "repo", runId: 42 });
    });
});
