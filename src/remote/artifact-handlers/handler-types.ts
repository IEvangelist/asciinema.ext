import * as vscode from "vscode";
import type { ExtractedArtifact } from "../zip-extract.js";
import type { WorkflowArtifact, WorkflowRunSummary } from "../github-client.js";
import type { PullRequestCoordinates } from "../parse-pr-url.js";

/**
 * Context passed to every artifact handler. Built once after the artifact
 * zip has been downloaded and inflated to disk.
 */
export interface HandlerContext {
    readonly extensionContext: vscode.ExtensionContext;
    readonly coords: PullRequestCoordinates;
    readonly run: WorkflowRunSummary;
    readonly artifact: WorkflowArtifact;
    readonly extracted: ExtractedArtifact;
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
