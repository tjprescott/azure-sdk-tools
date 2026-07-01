import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
    OperationArtifactNames,
    OperationStatus,
    OperationUpdate,
    ReviewPullRequestCreationAcceptedResponse,
    ReviewPullRequestCreationRequest,
} from "../models/models.js";
import { publishApiReviewPullRequest } from "../github/repository-actions.js";
import { downloadBuildArtifact, type DownloadedAdoArtifact, queueApiReviewPipeline } from "./ado-pipeline-service.js";

export interface ReviewPullRequestCreationResult {
    readonly reviewPullRequest: Record<string, unknown>;
    readonly log?: string;
}

export interface ReviewPullRequestCreationOptions {
    readonly operationId?: string;
    readonly onLog?: (message: string) => void;
}

const operations = new Map<string, OperationStatus>();
const operationRequests = new Map<string, ReviewPullRequestCreationRequest>();

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
    operationRequests.set(operationId, request);

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

    const updatedOperation: OperationStatus = {
        ...operation,
        operationId,
        status: "running",
        failureReason: update.result === "Succeeded" || update.result === "SucceededWithIssues"
            ? operation.failureReason
            : `Artifact generation completed with result ${update.result}.`,
    };
    operations.set(operationId, updatedOperation);
    return updatedOperation;
}

export async function processOperationUpdateResults(operationId: string, update: OperationUpdate): Promise<void> {
    console.log(JSON.stringify({
        event: "operationUpdateProcessingStarted",
        operationId,
        buildId: update.buildId,
        pipelineProject: update.project,
    }));

    try {
        operations.set(operationId, {
            ...operations.get(operationId),
            operationId,
            status: "running",
            mode: update.mode,
            language: update.language,
            pipelineProject: update.project,
            buildId: update.buildId,
        });

        const resultSummary = await downloadResultSummary(update.project, update.buildId, update.artifacts.result);
        verifyResultSummary(operationId, update, resultSummary);

        if (update.mode !== "create") {
            throw new Error(`Operation mode '${update.mode}' is not implemented for review PR publishing yet.`);
        }

        const artifactNames = getRequiredCreateArtifactNames(update.artifacts);
        const [baseArtifact, targetArtifact] = await Promise.all([
            downloadApiArtifact(update.project, update.buildId, artifactNames.base),
            downloadApiArtifact(update.project, update.buildId, artifactNames.target),
        ]);

        if (baseArtifact.apiMd.equals(targetArtifact.apiMd)) {
            throw new Error("The baseline and target API artifacts are identical; no review pull request was created.");
        }

        const repository = resolveRepository(operationId, resultSummary);
        const targetBranch = operationRequests.get(operationId)?.targetBranch.name ?? getRequiredString(resultSummary.targetRef, "result-summary.targetRef");
        const packageName = getRequiredString(resultSummary.packageName, "result-summary.packageName");
        const baseRef = getRequiredString(resultSummary.baseRef ?? baseArtifact.metadata.ref, "result-summary.baseRef");
        const targetRef = getRequiredString(resultSummary.targetRef ?? targetArtifact.metadata.ref, "result-summary.targetRef");
        const baseVersion = getRequiredString(resultSummary.baseVersion ?? baseArtifact.metadata.version, "result-summary.baseVersion");
        const targetVersion = getRequiredString(resultSummary.targetVersion ?? targetArtifact.metadata.version, "result-summary.targetVersion");
        const branchPackageName = sanitizeBranchSegment(packageName);
        const baseBranch = `apireview/base_${branchPackageName}_${sanitizeBranchSegment(baseVersion)}`;
        const reviewBranch = `apireview/review_${branchPackageName}_${sanitizeBranchSegment(targetVersion)}`;
        const packageRelativePath = getRequiredString(
            resultSummary.packageRelativePath ?? targetArtifact.metadata.packageRelativePath ?? baseArtifact.metadata.packageRelativePath,
            "result-summary.packageRelativePath",
        );

        const reviewPullRequest = await publishApiReviewPullRequest({
            owner: repository.owner,
            repo: repository.repo,
            targetBranch,
            baseBranch,
            reviewBranch,
            packageName,
            baseRef,
            targetRef,
            baseVersion,
            targetVersion,
            baseFiles: {
                packageRelativePath,
                apiMd: baseArtifact.apiMd.toString("utf8"),
                apiMetadataYaml: baseArtifact.apiMetadataYaml.toString("utf8"),
            },
            targetFiles: {
                packageRelativePath,
                apiMd: targetArtifact.apiMd.toString("utf8"),
                apiMetadataYaml: targetArtifact.apiMetadataYaml.toString("utf8"),
            },
        });

        operations.set(operationId, {
            ...operations.get(operationId),
            operationId,
            status: "succeeded",
            mode: update.mode,
            language: update.language,
            packageName,
            pipelineProject: update.project,
            buildId: update.buildId,
            reviewPullRequest,
            failureReason: undefined,
        });

        console.log(JSON.stringify({
            event: "operationUpdateProcessingSucceeded",
            operationId,
            buildId: update.buildId,
            reviewPullRequest,
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        operations.set(operationId, {
            ...operations.get(operationId),
            operationId,
            status: "failed",
            mode: update.mode,
            language: update.language,
            pipelineProject: update.project,
            buildId: update.buildId,
            failureReason: message,
        });
        throw error;
    }
}

interface ResultSummary {
    readonly operationId?: string;
    readonly mode?: string;
    readonly language?: string;
    readonly repositoryFullName?: string;
    readonly packageName?: string;
    readonly baseRef?: string;
    readonly targetRef?: string;
    readonly status?: string;
    readonly changed?: boolean;
    readonly baseVersion?: string;
    readonly targetVersion?: string;
    readonly packageRelativePath?: string;
}

interface ArtifactMetadata {
    readonly packageName?: string;
    readonly packageRelativePath?: string;
    readonly ref?: string;
    readonly version?: string;
}

interface ApiArtifactFiles {
    readonly apiMd: Buffer;
    readonly apiMetadataYaml: Buffer;
    readonly metadata: ArtifactMetadata;
}

async function downloadResultSummary(project: string, buildId: string, artifactName: string): Promise<ResultSummary> {
    const artifact = await getOperationArtifact(project, buildId, artifactName);
    const resultSummary = getRequiredArtifactFile(artifact, "result-summary.json");
    return JSON.parse(resultSummary.toString("utf8")) as ResultSummary;
}

async function downloadApiArtifact(project: string, buildId: string, artifactName: string): Promise<ApiArtifactFiles> {
    const artifact = await getOperationArtifact(project, buildId, artifactName);
    const apiMd = getRequiredArtifactFile(artifact, "api.md");
    const apiMetadataYaml = getRequiredArtifactFile(artifact, "api.metadata.yml");
    const metadata = JSON.parse(getRequiredArtifactFile(artifact, "artifact-metadata.json").toString("utf8")) as ArtifactMetadata;
    return { apiMd, apiMetadataYaml, metadata };
}

async function getOperationArtifact(project: string, buildId: string, artifactName: string): Promise<DownloadedAdoArtifact> {
    return downloadBuildArtifact(project, buildId, artifactName);
}

function getRequiredArtifactFile(artifact: DownloadedAdoArtifact, fileName: string): Buffer {
    for (const [entryName, content] of artifact.files) {
        if (entryName === fileName || entryName.endsWith(`/${fileName}`)) {
            return content;
        }
    }

    throw new Error(`Artifact '${artifact.name}' did not contain required file '${fileName}'.`);
}

function verifyResultSummary(operationId: string, update: OperationUpdate, resultSummary: ResultSummary): void {
    if (resultSummary.operationId && resultSummary.operationId !== operationId) {
        throw new Error(`Result summary operationId '${resultSummary.operationId}' did not match callback operationId '${operationId}'.`);
    }

    if (resultSummary.mode && resultSummary.mode !== update.mode) {
        throw new Error(`Result summary mode '${resultSummary.mode}' did not match callback mode '${update.mode}'.`);
    }

    if (resultSummary.language && resultSummary.language !== update.language) {
        throw new Error(`Result summary language '${resultSummary.language}' did not match callback language '${update.language}'.`);
    }

    const operation = operations.get(operationId);
    if (operation?.packageName && resultSummary.packageName && operation.packageName !== resultSummary.packageName) {
        throw new Error(`Result summary packageName '${resultSummary.packageName}' did not match operation packageName '${operation.packageName}'.`);
    }
}

function getRequiredCreateArtifactNames(artifacts: OperationArtifactNames): { base: string; target: string } {
    if (!artifacts.base) {
        throw new Error("Create operation callback did not include artifacts.base.");
    }

    if (!artifacts.target) {
        throw new Error("Create operation callback did not include artifacts.target.");
    }

    return {
        base: artifacts.base,
        target: artifacts.target,
    };
}

function resolveRepository(operationId: string, resultSummary: ResultSummary): { owner: string; repo: string } {
    const targetBranch = operationRequests.get(operationId)?.targetBranch;
    if (targetBranch) {
        return {
            owner: targetBranch.owner,
            repo: targetBranch.repo,
        };
    }

    const repositoryFullName = getRequiredString(resultSummary.repositoryFullName, "result-summary.repositoryFullName");
    const [owner, repo] = repositoryFullName.split("/", 2);
    if (!owner || !repo) {
        throw new Error(`Result summary repositoryFullName '${repositoryFullName}' was not in owner/repo format.`);
    }

    return { owner, repo };
}

function getRequiredString(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`Missing required ${name}.`);
    }

    return value;
}

function sanitizeBranchSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
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
