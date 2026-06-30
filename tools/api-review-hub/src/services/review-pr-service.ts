import { randomUUID } from "node:crypto";

import type {
    OperationStatus,
    OperationUpdate,
    ReviewPullRequestCreationAcceptedResponse,
    ReviewPullRequestCreationRequest,
} from "../models/models.js";
import { queueApiReviewPipeline } from "./ado-pipeline-service.js";

export interface ReviewPullRequestCreationResult {
    readonly reviewPullRequest: Record<string, unknown>;
    readonly log?: string;
}

export interface ReviewPullRequestCreationOptions {
    readonly operationId?: string;
    readonly onLog?: (message: string) => void;
}

const operations = new Map<string, OperationStatus>();

export class OperationUpdateConflictError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "OperationUpdateConflictError";
    }
}

export async function acceptReviewPullRequestCreation(
    request: ReviewPullRequestCreationRequest,
): Promise<ReviewPullRequestCreationAcceptedResponse> {
    const operationId = randomUUID();
    const pipelineProject = "playground";
    const pipelineId = "8259";

    console.log(JSON.stringify({
        event: "apiReviewPipelineQueueRequested",
        operationId,
        pipelineProject,
        pipelineId,
        requestMode: "create",
        language: request.language,
        packageName: request.packageName,
        baseRef: request.baseTag,
        targetOwner: request.targetBranch.owner,
        targetRepo: request.targetBranch.repo,
        targetRef: request.targetBranch.name,
    }));

    const queuedRun = await queueApiReviewPipeline({
        operationId,
        pipelineProject,
        pipelineId,
        requestMode: "create",
        language: request.language,
        packageName: request.packageName,
        baseRef: request.baseTag,
        targetRef: request.targetBranch.name,
    });

    console.log(JSON.stringify({
        event: "apiReviewPipelineQueued",
        operationId,
        pipelineProject,
        pipelineId,
        buildId: queuedRun.buildId,
        runUrl: queuedRun.runUrl,
    }));

    operations.set(operationId, {
        operationId,
        status: "running",
        mode: "create",
        language: request.language,
        packageName: request.packageName,
        pipelineProject,
        pipelineId,
        buildId: queuedRun.buildId,
        pipelineUrl: queuedRun.runUrl,
    });

    return { operationId, status: "accepted" };
}

export function getOperation(operationId: string): OperationStatus | undefined {
    return operations.get(operationId);
}

export function acceptOperationUpdate(operationId: string, update: OperationUpdate): OperationStatus | undefined {
    const operation = operations.get(operationId);
    if (!operation) {
        return undefined;
    }

    if (operation.buildId && update.buildId !== operation.buildId) {
        throw new OperationUpdateConflictError(`Operation ${operationId} is associated with Azure DevOps build ${operation.buildId}, not ${update.buildId}.`);
    }

    if (operation.mode && update.mode !== operation.mode) {
        throw new OperationUpdateConflictError(`Operation ${operationId} is associated with mode ${operation.mode}, not ${update.mode}.`);
    }

    if (operation.language && update.language !== operation.language) {
        throw new OperationUpdateConflictError(`Operation ${operationId} is associated with language ${operation.language}, not ${update.language}.`);
    }

    const status = update.result === "Succeeded" || update.result === "SucceededWithIssues" ? "succeeded" : "failed";
    const updatedOperation: OperationStatus = {
        ...operation,
        operationId,
        status,
        failureReason: status === "failed" ? `Artifact generation completed with result ${update.result}.` : operation.failureReason,
    };
    operations.set(operationId, updatedOperation);
    return updatedOperation;
}

export async function createReviewPullRequest(
    _request: ReviewPullRequestCreationRequest,
    options: ReviewPullRequestCreationOptions = {},
): Promise<ReviewPullRequestCreationResult> {
    const operationId = options.operationId ?? randomUUID();

    return {
        reviewPullRequest: {
            operationId,
            status: "notImplemented",
        },
        log: "Review PR creation is not implemented yet.",
    };
}
