import * as vscode from "vscode";
import type { ExtractedArtifact } from "../zip-extract.js";
import type { ArtifactBundle } from "../artifact-bundle.js";
import type { WorkflowArtifact, WorkflowRunSummary } from "../github-client.js";
import type { RepoCoordinates } from "../artifact-source.js";

/**
 * Context passed to every artifact handler. Built once after the artifact
 * zip has been downloaded and peeked. Handlers see only the owner+repo
 * coordinates — PR/run-specific metadata lives on the persisted
 * `RecentArtifact` (and its `source` discriminator), not here.
 *
 * `bundle` is always present and carries the cached `.zip` path plus the
 * entry listing. `extracted` is only populated *after* the dispatcher has
 * decided that a non-HTML handler needs an on-disk tree (cast / browse
 * fallback), or when re-opening a legacy v2 recent that was stored as an
 * extracted directory.
 */
export interface HandlerContext {
    readonly extensionContext: vscode.ExtensionContext;
    readonly coords: RepoCoordinates;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly bundle: ArtifactBundle;
    extracted?: ExtractedArtifact;
}

/**
 * Result of a handler's `detect` call. Carries any handler-specific data
 * that the QuickPick + open step want to display.
 */
export interface HandlerCandidate {
    readonly id: string;
    readonly icon: string;
    readonly label: string;
    readonly description: string;
    readonly detail: string;
    readonly priority: number;
    readonly data: unknown;
}

export interface ArtifactHandler {
    detect(
        ctx: HandlerContext
    ): HandlerCandidate | Promise<HandlerCandidate | null> | null;
    open(ctx: HandlerContext, candidate: HandlerCandidate): Promise<void>;
}
