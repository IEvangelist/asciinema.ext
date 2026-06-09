import * as vscode from "vscode";
import type { RepoCoordinates } from "./artifact-source.js";
import {
    listArtifactsForRun,
    listPullRequests,
    listWorkflowRunsForSha,
    type PullRequestSummary,
    type WorkflowRunSummary,
} from "./github-client.js";
import { conclusionIcon, formatRelativeTime } from "./quickpick-helpers.js";
import { acquireSession, runPrFlow } from "./pr-flow.js";
import { isWorkflowRunActive } from "./workflow-run-state.js";

const REFRESH_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("refresh"),
    tooltip: "Refresh pull requests",
};

const OPEN_REPO_BTN: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("repo"),
    tooltip: "Open repository on github.com",
};

const MAX_PULL_REQUESTS = 30;
const ENRICH_CONCURRENCY = 4;
const RUNS_PER_PR = 10;
const MAX_COMPLETED_RUNS_TO_CHECK = 3;

type PullRequestEnrichment =
    | { readonly kind: "checking" }
    | {
          readonly kind: "has-artifacts";
          readonly run: WorkflowRunSummary;
          readonly artifactCount: number;
      }
    | { readonly kind: "ci-active"; readonly run: WorkflowRunSummary }
    | { readonly kind: "no-runs" }
    | { readonly kind: "no-artifacts" }
    | { readonly kind: "error"; readonly message: string };

interface ExplorePrItem extends vscode.QuickPickItem {
    readonly id: string;
    readonly pr?: PullRequestSummary;
    readonly action?: "refresh" | "open-repo";
}

export async function runExploreRepositoryFlow(
    context: vscode.ExtensionContext,
    repo: RepoCoordinates
): Promise<void> {
    const session = await acquireSession();
    if (!session) {
        return;
    }
    const token = session.accessToken;
    const selected = await pickPullRequestForRepository(token, repo);
    if (!selected) {
        return;
    }
    await runPrFlow(context, {
        owner: repo.owner,
        repo: repo.repo,
        number: selected.number,
    });
}

async function pickPullRequestForRepository(
    token: string,
    repo: RepoCoordinates
): Promise<PullRequestSummary | undefined> {
    const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`;
    return await new Promise<PullRequestSummary | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<ExplorePrItem>();
        let disposed = false;
        let settled = false;
        let generation = 0;
        let rows: readonly PullRequestSummary[] = [];
        let statuses = new Map<number, PullRequestEnrichment>();
        let lastUpdatedAt: Date | undefined;

        const finish = (value: PullRequestSummary | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
            if (!disposed) {
                qp.hide();
            }
        };

        const setItems = (items: readonly ExplorePrItem[]) => {
            if (disposed) {
                return;
            }
            const activeId = qp.activeItems[0]?.id;
            qp.items = items;
            if (activeId) {
                const next = items.find((item) => item.id === activeId);
                if (next) {
                    qp.activeItems = [next];
                }
            }
        };

        const render = () => {
            setItems(buildItems(rows, statuses, lastUpdatedAt, repo));
            qp.placeholder = buildPlaceholder(rows, lastUpdatedAt);
        };

        const refresh = async () => {
            const currentGeneration = ++generation;
            qp.busy = true;
            qp.placeholder = "Loading pull requests...";
            try {
                const pullRequests = await listPullRequests(token, repo, {
                    state: "open",
                    perPage: MAX_PULL_REQUESTS,
                });
                if (disposed || currentGeneration !== generation) {
                    return;
                }
                rows = pullRequests;
                statuses = new Map(
                    pullRequests.map((pr) => [
                        pr.number,
                        { kind: "checking" } as PullRequestEnrichment,
                    ])
                );
                lastUpdatedAt = new Date();
                render();
                void enrichRows(currentGeneration, pullRequests);
            } catch (err) {
                if (disposed || currentGeneration !== generation) {
                    return;
                }
                setItems(buildErrorItems(repo, err));
                qp.placeholder =
                    "Couldn't load pull requests — press refresh to retry";
            } finally {
                if (!disposed && currentGeneration === generation) {
                    qp.busy = false;
                }
            }
        };

        const enrichRows = async (
            currentGeneration: number,
            pullRequests: readonly PullRequestSummary[]
        ) => {
            let index = 0;
            const worker = async () => {
                while (true) {
                    if (disposed || currentGeneration !== generation) {
                        return;
                    }
                    const current = index++;
                    if (current >= pullRequests.length) {
                        return;
                    }
                    const pr = pullRequests[current];
                    const enrichment = await enrichPullRequest(
                        token,
                        repo,
                        pr
                    );
                    if (disposed || currentGeneration !== generation) {
                        return;
                    }
                    statuses.set(pr.number, enrichment);
                    render();
                }
            };

            const workers = Array.from(
                { length: Math.min(ENRICH_CONCURRENCY, pullRequests.length) },
                () => worker()
            );
            await Promise.all(workers);
        };

        qp.title = `GitHub Artifacts — Explore ${repo.owner}/${repo.repo}`;
        qp.placeholder = "Loading pull requests...";
        qp.ignoreFocusOut = true;
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.keepScrollPosition = true;
        qp.buttons = [REFRESH_BTN, OPEN_REPO_BTN];
        qp.items = [
            {
                id: "loading",
                label: "$(sync~spin)  Loading pull requests...",
            },
        ];

        qp.onDidTriggerButton((button) => {
            if (button === REFRESH_BTN) {
                void refresh();
                return;
            }
            if (button === OPEN_REPO_BTN) {
                void vscode.env.openExternal(vscode.Uri.parse(repoUrl));
            }
        });

        qp.onDidAccept(() => {
            const selected = qp.selectedItems[0];
            if (selected?.pr) {
                finish(selected.pr);
                return;
            }
            if (selected?.action === "refresh") {
                void refresh();
                return;
            }
            if (selected?.action === "open-repo") {
                void vscode.env.openExternal(vscode.Uri.parse(repoUrl));
            }
        });

        qp.onDidHide(() => {
            disposed = true;
            qp.dispose();
            if (!settled) {
                settled = true;
                resolve(undefined);
            }
        });

        qp.show();
        void refresh();
    });
}

function buildItems(
    pullRequests: readonly PullRequestSummary[],
    statuses: ReadonlyMap<number, PullRequestEnrichment>,
    lastUpdatedAt: Date | undefined,
    repo: RepoCoordinates
): ExplorePrItem[] {
    if (pullRequests.length === 0) {
        return [
            {
                id: "empty",
                label: "$(circle-slash)  No open pull requests",
                description: `${repo.owner}/${repo.repo}`,
            },
            {
                id: "refresh",
                label: "$(refresh)  Refresh",
                action: "refresh",
            },
            {
                id: "open-repo",
                label: "$(link-external)  Open repository in browser",
                action: "open-repo",
            },
        ];
    }

    const items: ExplorePrItem[] = [
        {
            id: "prs",
            label: lastUpdatedAt
                ? `Open pull requests — refreshed ${lastUpdatedAt.toLocaleTimeString()}`
                : "Open pull requests",
            kind: vscode.QuickPickItemKind.Separator,
        },
    ];

    for (const pr of pullRequests) {
        const status = statuses.get(pr.number) ?? { kind: "checking" };
        const state = describeStatus(status);
        const author = pr.author ? `@${pr.author}` : "unknown author";
        const draft = pr.draft ? " · draft" : "";
        items.push({
            id: `pr:${pr.number}`,
            label: `$(git-pull-request)  #${pr.number} ${truncate(pr.title, 90)}`,
            description: `${state} · ${author}${draft} · updated ${formatRelativeTime(pr.updatedAt)}`,
            detail: `$(git-branch) ${pr.headRef}@${pr.headSha.slice(0, 7)}`,
            pr,
        });
    }

    items.push({
        id: "actions",
        label: "Actions",
        kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
        id: "refresh",
        label: "$(refresh)  Refresh pull requests",
        action: "refresh",
    });
    items.push({
        id: "open-repo",
        label: "$(link-external)  Open repository in browser",
        action: "open-repo",
    });

    return items;
}

function buildErrorItems(
    repo: RepoCoordinates,
    err: unknown
): ExplorePrItem[] {
    return [
        {
            id: "error",
            label: "$(error)  Couldn't load pull requests",
            description: truncate(safeErrorMessage(err), 140),
            detail: `${repo.owner}/${repo.repo}`,
        },
        {
            id: "refresh",
            label: "$(refresh)  Try again",
            action: "refresh",
        },
        {
            id: "open-repo",
            label: "$(link-external)  Open repository in browser",
            action: "open-repo",
        },
    ];
}

function buildPlaceholder(
    pullRequests: readonly PullRequestSummary[],
    lastUpdatedAt: Date | undefined
): string {
    if (pullRequests.length === 0) {
        return "No open pull requests found";
    }
    const updated = lastUpdatedAt
        ? ` · updated ${lastUpdatedAt.toLocaleTimeString()}`
        : "";
    return `Select a pull request to find artifacts${updated}`;
}

async function enrichPullRequest(
    token: string,
    repo: RepoCoordinates,
    pullRequest: PullRequestSummary
): Promise<PullRequestEnrichment> {
    try {
        const runs = await listWorkflowRunsForSha(token, repo, pullRequest.headSha, {
            perPage: RUNS_PER_PR,
        });
        if (runs.length === 0) {
            return { kind: "no-runs" };
        }

        let activeRun: WorkflowRunSummary | undefined;
        const completedRuns: WorkflowRunSummary[] = [];
        for (const run of runs) {
            if (!activeRun && isWorkflowRunActive(run)) {
                activeRun = run;
            }
            if (run.status === "completed") {
                completedRuns.push(run);
            }
        }

        for (const run of completedRuns.slice(0, MAX_COMPLETED_RUNS_TO_CHECK)) {
            const artifacts = await listArtifactsForRun(token, repo, run.id);
            if (artifacts.length > 0) {
                return {
                    kind: "has-artifacts",
                    run,
                    artifactCount: artifacts.length,
                };
            }
        }

        if (activeRun) {
            return { kind: "ci-active", run: activeRun };
        }

        return { kind: "no-artifacts" };
    } catch (err) {
        return { kind: "error", message: normalizeEnrichmentError(err) };
    }
}

function describeStatus(status: PullRequestEnrichment): string {
    switch (status.kind) {
        case "checking":
            return "$(sync~spin) checking CI/artifacts";
        case "has-artifacts": {
            const icon = conclusionIcon(status.run.conclusion ?? status.run.status);
            const artifactLabel = status.artifactCount === 1
                ? "1 artifact"
                : `${status.artifactCount} artifacts`;
            return `${icon} ${status.run.name ?? "workflow"} #${status.run.runNumber} · ${artifactLabel}`;
        }
        case "ci-active":
            return `$(sync~spin) ${status.run.name ?? "workflow"} #${status.run.runNumber} is ${status.run.status ?? "active"}`;
        case "no-runs":
            return "$(circle-outline) no Actions runs yet";
        case "no-artifacts":
            return "$(circle-slash) no non-expired artifacts";
        case "error":
            return `$(warning) ${status.message}`;
    }
}

function normalizeEnrichmentError(err: unknown): string {
    const message = safeErrorMessage(err);
    if (/rate limit/i.test(message)) {
        return "GitHub API rate limit reached";
    }
    return truncate(message, 100);
}

function safeErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) {
        return err.message;
    }
    return String(err);
}

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
}
