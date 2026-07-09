import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient, type KeyVaultSecret } from "@azure/keyvault-secrets";

import { getRequiredSetting } from "../config/settings.js";
import { deleteGitBranch, enforceWorkingPullRequestApiApprovalLabel, getApiHashForPackageAtCommit, getOpenPullRequestHeadBranch, isApiApprovalManagedLabel, isArchitectReviewerForPackage, markReviewPullRequestOutOfDate, removeMisusedApiApprovalLabel, syncWorkingPullRequestApiApprovalLabel } from "../github/repository-actions.js";
import type { RepositoryRegistration } from "../models/models.js";
import { upsertApprovalRecord } from "../services/approval-record-store.js";
import {
    findOpenReviewPullRequestsByBaseBranch,
    findOpenReviewPullRequestsByWorkingBranch,
    getReviewPullRequestRecord,
    updateReviewPullRequestApprovalStatus,
    updateReviewPullRequestStatus,
    type ReviewPullRequestRecord,
    type ApprovalStatus,
    type ReviewPullRequestStatus,
} from "../services/review-pr-store.js";
import { acceptReviewPullRequestUpdate } from "../services/review-pr-service.js";
import { evaluateReleaseGate } from "../services/release-service.js";
import { tryCreateWebhookEventRecord, updateWebhookEventRecord } from "../services/webhook-event-store.js";
import { getRequiredHeader, logRequest, readRequestBody, sendEmpty, sendError } from "./http.js";

interface GitHubWebhookPayload {
    readonly action?: string;
    readonly installation?: {
        readonly id?: number;
    };
    readonly repository?: {
        readonly id?: number;
        readonly full_name?: string;
    };
    readonly sender?: {
        readonly login?: string;
    };
    readonly pull_request?: {
        readonly number?: number;
        readonly state?: string;
        readonly draft?: boolean;
        readonly merged?: boolean;
    };
    readonly review?: {
        readonly id?: number;
        readonly state?: string;
        readonly commit_id?: string;
        readonly user?: {
            readonly login?: string;
        };
    };
    readonly issue?: {
        readonly number?: number;
    };
    readonly label?: {
        readonly name?: string;
    };
    readonly comment?: {
        readonly id?: number;
        readonly html_url?: string;
        readonly body?: string;
        readonly user?: {
            readonly login?: string;
        };
    };
    readonly ref?: string;
    readonly before?: string;
    readonly after?: string;
    readonly head_commit?: GitHubPushCommit;
    readonly commits?: GitHubPushCommit[];
}

interface GitHubPushCommit {
    readonly id?: string;
    readonly added?: string[];
    readonly modified?: string[];
    readonly removed?: string[];
}

interface WebhookSecretKey {
    readonly name: string;
    readonly role: "current" | "previous";
}

interface WebhookSecretLookupResult extends WebhookSecretKey {
    readonly value?: string;
    readonly failureReason?: string;
    readonly enabled?: boolean;
    readonly expiresOn?: string;
    readonly notBefore?: string;
}

interface GitHubSignatureValidationResult {
    readonly valid: boolean;
    readonly result?: "invalidSignature" | "invalidSignatureFormat" | "unusableWebhookSecret";
    readonly failureReason?: string;
}

type ManagedApiApprovalLabelAction = "labeled" | "unlabeled";

interface ManagedApiApprovalLabelWebhookOptions {
    readonly eventType: "issues" | "pull_request";
    readonly deliveryId: string;
    readonly githubRepositoryId: number;
    readonly payload: GitHubWebhookPayload;
    readonly pullRequestNumber: number;
    readonly labelName: string;
    readonly action: ManagedApiApprovalLabelAction;
}

const credential = new DefaultAzureCredential();
const maxLoggedCommentBodyLength = 4000;
const repositoryRegistrationsContainerName = "repositoryRegistrations";
let cosmosClient: CosmosClient | undefined;
let repositoryRegistrationsContainer: Container | undefined;
let secretClient: SecretClient | undefined;

export async function handleGitHubWebhookEvent(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const eventType = getRequiredHeader(request, "X-GitHub-Event");
    const deliveryId = getRequiredHeader(request, "X-GitHub-Delivery");
    const hookId = getRequiredHeader(request, "X-GitHub-Hook-ID");
    const hookInstallationTargetId = getRequiredHeader(request, "X-GitHub-Hook-Installation-Target-ID");
    const hookInstallationTargetType = getRequiredHeader(request, "X-GitHub-Hook-Installation-Target-Type");
    const signatureSha256 = getRequiredHeader(request, "X-Hub-Signature-256");
    const contentType = getRequiredHeader(request, "Content-Type");
    const payload = await readRequestBody(request);

    if (!eventType) {
        logRejectedWebhookDelivery("missingHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "missingHeader", "The GitHub event header is required.", "X-GitHub-Event");
        return;
    }
    if (!deliveryId) {
        logRejectedWebhookDelivery("missingHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "missingHeader", "The GitHub delivery header is required.", "X-GitHub-Delivery");
        return;
    }
    if (!signatureSha256) {
        logRejectedWebhookDelivery("missingHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "missingHeader", "The GitHub signature header is required.", "X-Hub-Signature-256");
        return;
    }
    if (!hookId) {
        logRejectedWebhookDelivery("missingHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "missingHeader", "The GitHub hook ID header is required.", "X-GitHub-Hook-ID");
        return;
    }
    if (!hookInstallationTargetId) {
        logRejectedWebhookDelivery("missingHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(
            response,
            400,
            "missingHeader",
            "The GitHub hook installation target ID header is required.",
            "X-GitHub-Hook-Installation-Target-ID",
        );
        return;
    }
    if (hookInstallationTargetType !== "repository") {
        logRejectedWebhookDelivery("unsupportedHookTarget", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "unsupportedHookTarget", "The GitHub hook installation target must be a repository.");
        return;
    }
    if (payload.length === 0) {
        logRejectedWebhookDelivery("missingBody", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "missingBody", "The GitHub webhook payload is required.");
        return;
    }

    const githubRepositoryId = parseGitHubId(hookInstallationTargetId);
    if (githubRepositoryId === undefined) {
        logRejectedWebhookDelivery("invalidHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(
            response,
            400,
            "invalidHeader",
            "The GitHub hook installation target ID header must be a positive integer.",
            "X-GitHub-Hook-Installation-Target-ID",
        );
        return;
    }

    const githubWebhookId = parseGitHubId(hookId);
    if (githubWebhookId === undefined) {
        logRejectedWebhookDelivery("invalidHeader", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "invalidHeader", "The GitHub hook ID header must be a positive integer.", "X-GitHub-Hook-ID");
        return;
    }

    const decodedPayload = decodeGitHubWebhookPayload(payload, contentType);

    const repositoryRegistration = await getRepositoryRegistration(githubRepositoryId);
    if (!repositoryRegistration) {
        await tryCreateWebhookEventRecord({
            deliveryId,
            githubRepositoryId,
            githubWebhookId,
            repositoryFullName: decodedPayload?.repository?.full_name,
            eventType,
            contentType,
            action: decodedPayload?.action,
            sender: decodedPayload?.sender?.login,
            pullRequestNumber: decodedPayload?.pull_request?.number,
            reviewId: decodedPayload?.review?.id,
            ref: decodedPayload?.ref,
            before: decodedPayload?.before,
            after: decodedPayload?.after,
            status: "rejected",
            result: "unknownRepository",
            failureReason: "The GitHub repository is not registered for webhook processing.",
        });
        logWebhookRegistrationError("unknownRepository", eventType, deliveryId, contentType, payload.length, githubRepositoryId, githubWebhookId);
        sendError(response, 401, "unknownRepository", "The GitHub repository is not registered for webhook processing.");
        return;
    }
    if (repositoryRegistration.status !== "active") {
        logWebhookRegistrationError("disabledRepository", eventType, deliveryId, contentType, payload.length, githubRepositoryId, githubWebhookId);
        sendError(response, 403, "disabledRepository", "The GitHub repository registration is not active.");
        return;
    }
    if (repositoryRegistration.githubWebhookId !== githubWebhookId) {
        logRejectedWebhookDelivery("unknownWebhook", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 401, "unknownWebhook", "The GitHub webhook is not registered for this repository.");
        return;
    }

    const signatureValidation = await validateGitHubSignature(signatureSha256, payload, repositoryRegistration);
    if (!signatureValidation.valid) {
        await tryCreateWebhookEventRecord({
            deliveryId,
            githubRepositoryId,
            githubWebhookId,
            repositoryFullName: repositoryRegistration.repositoryFullName,
            eventType,
            contentType,
            status: "rejected",
            result: signatureValidation.result ?? "invalidSignature",
            failureReason: signatureValidation.failureReason ?? "The GitHub webhook signature is invalid for the registered repository secrets.",
        });
        logRejectedWebhookDelivery(signatureValidation.result ?? "invalidSignature", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 401, "invalidSignature", "The GitHub webhook signature is invalid.", "X-Hub-Signature-256");
        return;
    }

    if (!decodedPayload) {
        await tryCreateWebhookEventRecord({
            deliveryId,
            githubRepositoryId,
            githubWebhookId,
            repositoryFullName: repositoryRegistration.repositoryFullName,
            eventType,
            contentType,
            status: "rejected",
            result: "invalidBody",
            failureReason: "The GitHub webhook payload must be valid JSON.",
        });
        logRejectedWebhookDelivery("invalidBody", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 400, "invalidBody", "The GitHub webhook payload must be valid JSON.");
        return;
    }
    if (decodedPayload.repository?.id !== repositoryRegistration.githubRepositoryId) {
        logRejectedWebhookDelivery("repositoryMismatch", eventType, deliveryId, signatureSha256, contentType, payload.length);
        sendError(response, 401, "repositoryMismatch", "The GitHub webhook payload repository does not match the registration.");
        return;
    }

    logRequest("POST /api/github/webhook-events", {
        eventType,
        deliveryId,
        hasSignatureSha256: true,
        contentType,
        payloadBytes: payload.length,
        hookId,
        hookInstallationTargetId,
        hookInstallationTargetType,
        action: decodedPayload.action,
        installationId: decodedPayload.installation?.id,
        repositoryId: decodedPayload.repository?.id,
        repository: decodedPayload.repository?.full_name,
        sender: decodedPayload.sender?.login,
        pullRequestNumber: decodedPayload.pull_request?.number,
        reviewId: decodedPayload.review?.id,
        reviewState: decodedPayload.review?.state,
        reviewAuthor: decodedPayload.review?.user?.login,
        issueNumber: decodedPayload.issue?.number,
        labelName: decodedPayload.label?.name,
        commentId: decodedPayload.comment?.id,
        commentUrl: decodedPayload.comment?.html_url,
        commentAuthor: decodedPayload.comment?.user?.login,
        commentBody: truncateLogValue(decodedPayload.comment?.body),
        ref: decodedPayload.ref,
    });

    const webhookEventRecord = await tryCreateWebhookEventRecord({
        deliveryId,
        githubRepositoryId,
        githubWebhookId,
        repositoryFullName: decodedPayload.repository?.full_name,
        eventType,
        contentType,
        action: decodedPayload.action,
        sender: decodedPayload.sender?.login,
        pullRequestNumber: decodedPayload.pull_request?.number,
        reviewId: decodedPayload.review?.id,
        ref: decodedPayload.ref,
        before: decodedPayload.before,
        after: decodedPayload.after,
        status: "accepted",
    });

    if (!webhookEventRecord) {
        logRequest("POST /api/github/webhook-events duplicate", {
            eventType,
            deliveryId,
            githubRepositoryId,
            repository: decodedPayload.repository?.full_name,
        });
        sendEmpty(response, 202);
        return;
    }

    await updateWebhookEventRecord({
        deliveryId,
        githubRepositoryId,
        status: "processing",
    });

    try {
        await processGitHubWebhookEvent(eventType, deliveryId, githubRepositoryId, decodedPayload);
        await updateWebhookEventRecord({
            deliveryId,
            githubRepositoryId,
            status: "processed",
            result: "processed",
        });
    } catch (error) {
        await updateWebhookEventRecord({
            deliveryId,
            githubRepositoryId,
            status: "failed",
            result: "failed",
            failureReason: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }

    sendEmpty(response, 202);
}

async function processGitHubWebhookEvent(
    eventType: string,
    deliveryId: string,
    githubRepositoryId: number,
    payload: GitHubWebhookPayload,
): Promise<void> {
    switch (eventType) {
        case "push":
            await handlePushWebhookEvent(deliveryId, githubRepositoryId, payload);
            return;
        case "pull_request":
            await handlePullRequestWebhookEvent(deliveryId, githubRepositoryId, payload);
            return;
        case "pull_request_review":
            await handlePullRequestReviewWebhookEvent(deliveryId, githubRepositoryId, payload);
            return;
        case "issues":
            await handleIssuesWebhookEvent(deliveryId, githubRepositoryId, payload);
            return;
        default:
            logRequest("POST /api/github/webhook-events ignored", {
                reason: "unsupportedEventType",
                eventType,
                deliveryId,
                githubRepositoryId,
            });
    }
}

async function handleIssuesWebhookEvent(deliveryId: string, githubRepositoryId: number, payload: GitHubWebhookPayload): Promise<void> {
    const issueNumber = payload.issue?.number;
    const labelName = payload.label?.name;
    if ((payload.action !== "labeled" && payload.action !== "unlabeled") || !issueNumber || !labelName || !isApiApprovalManagedLabel(labelName)) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "unsupportedIssuesEvent",
            eventType: "issues",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            issueNumber,
            labelName,
        });
        return;
    }

    await handleManagedApiApprovalLabelWebhookEvent({
        eventType: "issues",
        deliveryId,
        githubRepositoryId,
        payload,
        pullRequestNumber: issueNumber,
        labelName,
        action: payload.action,
    });
}

async function handleManagedApiApprovalLabelWebhookEvent(options: ManagedApiApprovalLabelWebhookOptions): Promise<void> {
    const repository = options.payload.repository?.full_name ? parseRepositoryFullName(options.payload.repository.full_name) : undefined;
    if (!repository) {
        console.warn(JSON.stringify({
            event: "managedApiApprovalLabelWebhookIgnoredForInvalidRepositoryFullName",
            eventType: options.eventType,
            deliveryId: options.deliveryId,
            githubRepositoryId: options.githubRepositoryId,
            repositoryFullName: options.payload.repository?.full_name,
            pullRequestNumber: options.pullRequestNumber,
            labelName: options.labelName,
        }));
        return;
    }

    const workingBranch = await getOpenPullRequestHeadBranch({
        owner: repository.owner,
        repo: repository.repo,
        pullRequestNumber: options.pullRequestNumber,
    });
    if (!workingBranch) {
        if (options.action === "labeled") {
            await removeMisusedApiApprovalLabel({
                owner: repository.owner,
                repo: repository.repo,
                issueNumber: options.pullRequestNumber,
                labelName: options.labelName,
            });
        }

        console.log(JSON.stringify({
            event: options.action === "labeled" ? "misusedApiApprovalLabelRemoved" : "managedApiApprovalLabelWebhookIgnoredForNonOpenPullRequest",
            eventType: options.eventType,
            deliveryId: options.deliveryId,
            githubRepositoryId: options.githubRepositoryId,
            pullRequestNumber: options.pullRequestNumber,
            labelName: options.labelName,
            action: options.action,
        }));
        return;
    }

    const reviewPullRequest = (await findOpenReviewPullRequestsByWorkingBranch(options.githubRepositoryId, workingBranch))
        .sort((left, right) => right.lastUpdatedOn.localeCompare(left.lastUpdatedOn))[0];
    if (!reviewPullRequest) {
        if (options.action === "labeled") {
            await removeMisusedApiApprovalLabel({
                owner: repository.owner,
                repo: repository.repo,
                issueNumber: options.pullRequestNumber,
                labelName: options.labelName,
            });
        }

        console.log(JSON.stringify({
            event: options.action === "labeled" ? "misusedApiApprovalLabelRemoved" : "managedApiApprovalLabelWebhookIgnoredForNonApiReviewWorkingPullRequest",
            eventType: options.eventType,
            deliveryId: options.deliveryId,
            githubRepositoryId: options.githubRepositoryId,
            pullRequestNumber: options.pullRequestNumber,
            labelName: options.labelName,
            action: options.action,
            workingBranch,
        }));
        return;
    }

    const releaseGateDecision = await evaluateReleaseGate({
        language: reviewPullRequest.language,
        packageName: reviewPullRequest.packageName,
        version: reviewPullRequest.targetVersion,
        apiHash: reviewPullRequest.approval.apiHash,
    });

    const reverted = await enforceWorkingPullRequestApiApprovalLabel({
        owner: repository.owner,
        repo: repository.repo,
        pullRequestNumber: options.pullRequestNumber,
        changedLabelName: options.labelName,
        action: options.action,
        approvalStatus: getApprovalLabelStatus(releaseGateDecision.reason),
        reviewPullRequestUrl: reviewPullRequest.pullRequestUrl,
    });

    console.log(JSON.stringify({
        event: reverted ? "managedApiApprovalLabelChangeReverted" : "managedApiApprovalLabelChangeAllowed",
        eventType: options.eventType,
        deliveryId: options.deliveryId,
        githubRepositoryId: options.githubRepositoryId,
        pullRequestNumber: options.pullRequestNumber,
        labelName: options.labelName,
        action: options.action,
        workingBranch,
        reviewPullRequestNumber: reviewPullRequest.pullRequestNumber,
        reviewPullRequestUrl: reviewPullRequest.pullRequestUrl,
        approvalStatus: reviewPullRequest.approval.status,
        releaseGateReason: releaseGateDecision.reason,
        releaseGateAllowed: releaseGateDecision.allowed,
    }));
}

async function handlePushWebhookEvent(deliveryId: string, githubRepositoryId: number, payload: GitHubWebhookPayload): Promise<void> {
    const workingBranch = getBranchNameFromGitRef(payload.ref);
    if (!workingBranch) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "unsupportedPushRef",
            eventType: "push",
            deliveryId,
            githubRepositoryId,
            ref: payload.ref,
        });
        return;
    }

    const changedFiles = getChangedFilesFromPushPayload(payload);
    const changedPackageNames = getChangedPackageNames(changedFiles);
    if (changedPackageNames.size === 0) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "noSdkPackagesChanged",
            eventType: "push",
            deliveryId,
            githubRepositoryId,
            workingBranch,
            before: payload.before,
            after: payload.after,
            changedFileCount: changedFiles.length,
        });
        return;
    }

    const reviewPullRequests = await findOpenReviewPullRequestsByWorkingBranch(githubRepositoryId, workingBranch);
    const matchingReviewPullRequests = reviewPullRequests.filter((reviewPullRequest) => changedPackageNames.has(reviewPullRequest.packageName));
    console.log(JSON.stringify({
        event: "reviewPullRequestsMatchedForWorkingBranchPush",
        deliveryId,
        githubRepositoryId,
        workingBranch,
        before: payload.before,
        after: payload.after,
        changedPackageNames: [...changedPackageNames],
        reviewPullRequestCount: reviewPullRequests.length,
        matchingReviewPullRequestCount: matchingReviewPullRequests.length,
        pullRequestNumbers: matchingReviewPullRequests.map((reviewPullRequest) => reviewPullRequest.pullRequestNumber),
    }));

    const targetRef = payload.after || workingBranch;
    for (const reviewPullRequest of matchingReviewPullRequests) {
        const repository = parseRepositoryFullName(reviewPullRequest.repositoryFullName);
        if (!repository) {
            console.warn(JSON.stringify({
                event: "reviewPullRequestUpdateSkippedForInvalidRepositoryFullName",
                deliveryId,
                githubRepositoryId,
                repositoryFullName: reviewPullRequest.repositoryFullName,
                pullRequestNumber: reviewPullRequest.pullRequestNumber,
            }));
            continue;
        }

        const acceptedUpdate = await acceptReviewPullRequestUpdate(reviewPullRequest, targetRef);
        await markReviewPullRequestOutOfDate({
            owner: repository.owner,
            repo: repository.repo,
            pullRequestNumber: reviewPullRequest.pullRequestNumber,
            operationId: acceptedUpdate.operationId,
            pipelineUrl: acceptedUpdate.pipelineUrl,
        });
        console.log(JSON.stringify({
            event: "reviewPullRequestUpdateQueuedForPush",
            deliveryId,
            githubRepositoryId,
            workingBranch,
            targetRef,
            packageName: reviewPullRequest.packageName,
            pullRequestNumber: reviewPullRequest.pullRequestNumber,
            operationId: acceptedUpdate.operationId,
            pipelineUrl: acceptedUpdate.pipelineUrl,
        }));
    }
}

async function handlePullRequestReviewWebhookEvent(deliveryId: string, githubRepositoryId: number, payload: GitHubWebhookPayload): Promise<void> {
    const pullRequestNumber = payload.pull_request?.number;
    const reviewer = payload.review?.user?.login;
    const reviewCommitSha = payload.review?.commit_id;
    if (!payload.action || !pullRequestNumber || !reviewer || !reviewCommitSha) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "invalidPullRequestReviewPayload",
            eventType: "pull_request_review",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber,
            reviewId: payload.review?.id,
            reviewState: payload.review?.state,
            reviewCommitSha,
            reviewer,
        });
        return;
    }

    const approvalStatus = getPullRequestReviewApprovalStatus(payload.action, payload.review?.state);
    if (!approvalStatus) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "unsupportedPullRequestReviewAction",
            eventType: "pull_request_review",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber,
            reviewId: payload.review?.id,
            reviewState: payload.review?.state,
            reviewCommitSha,
            reviewer,
        });
        return;
    }

    if (approvalStatus === "revoked") {
        console.log(JSON.stringify({
            event: "pullRequestReviewDismissalWebhookFields",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber,
            reviewId: payload.review?.id,
            reviewState: payload.review?.state,
            reviewCommitSha,
            reviewUserLogin: payload.review?.user?.login,
            senderLogin: payload.sender?.login,
            reviewer,
        }));
    }

    const reviewPullRequest = await getReviewPullRequestRecord(githubRepositoryId, pullRequestNumber);
    if (!reviewPullRequest) {
        console.log(JSON.stringify({
            event: "pullRequestReviewWebhookIgnoredForNonReviewPullRequest",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber,
            reviewId: payload.review?.id,
            reviewState: payload.review?.state,
            reviewCommitSha,
            reviewer,
        }));
        return;
    }

    const repository = parseRepositoryFullName(reviewPullRequest.repositoryFullName);
    if (!repository) {
        console.warn(JSON.stringify({
            event: "pullRequestReviewWebhookIgnoredForInvalidRepositoryFullName",
            deliveryId,
            githubRepositoryId,
            repositoryFullName: reviewPullRequest.repositoryFullName,
            pullRequestNumber,
            reviewId: payload.review?.id,
            reviewCommitSha,
            reviewer,
        }));
        return;
    }

    const reviewerIsArchitect = await isArchitectReviewerForPackage({
        owner: repository.owner,
        repo: repository.repo,
        packageRelativePath: reviewPullRequest.packageRelativePath,
        reviewer,
    });
    if (!reviewerIsArchitect) {
        console.log(JSON.stringify({
            event: "pullRequestReviewWebhookIgnoredForNonArchitectReviewer",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber,
            reviewId: payload.review?.id,
            reviewState: payload.review?.state,
            reviewCommitSha,
            reviewer,
            packageRelativePath: reviewPullRequest.packageRelativePath,
        }));
        return;
    }

    const apiHash = await getApiHashForPackageAtCommit({
        owner: repository.owner,
        repo: repository.repo,
        packageRelativePath: reviewPullRequest.packageRelativePath,
        commitSha: reviewCommitSha,
    });
    const updatedRecord = await updateReviewPullRequestApprovalStatus(githubRepositoryId, pullRequestNumber, approvalStatus, reviewer, apiHash, reviewCommitSha);
    const approvalRecord = updatedRecord
        ? await upsertApprovalRecord({
            reviewPullRequest: updatedRecord,
            apiHash,
            commitSha: reviewCommitSha,
            status: approvalStatus,
            githubReviewId: payload.review?.id,
            lastUpdatedBy: reviewer,
        })
        : undefined;
    const releaseGateDecision = updatedRecord
        ? await evaluateReleaseGate({
            language: updatedRecord.language,
            packageName: updatedRecord.packageName,
            version: updatedRecord.targetVersion,
            apiHash,
        })
        : undefined;
    const workingPullRequest = updatedRecord
        ? await syncWorkingPullRequestApiApprovalLabel({
            owner: repository.owner,
            repo: repository.repo,
            workingBranch: updatedRecord.workingBranch,
            approvalStatus: getApprovalLabelStatus(releaseGateDecision?.reason),
        })
        : undefined;
    console.log(JSON.stringify({
        event: updatedRecord ? "reviewPullRequestApprovalWebhookApplied" : "pullRequestReviewWebhookIgnoredForMissingReviewPullRequest",
        deliveryId,
        githubRepositoryId,
        action: payload.action,
        pullRequestNumber,
        reviewId: payload.review?.id,
        reviewState: payload.review?.state,
        reviewCommitSha,
        reviewer,
        approvalStatus,
        releaseGateReason: releaseGateDecision?.reason,
        releaseGateAllowed: releaseGateDecision?.allowed,
        apiHash,
        approvalRecordId: approvalRecord?.id,
        workingPullRequestNumber: workingPullRequest?.number,
    }));
}

function getApprovalLabelStatus(releaseGateReason: "approved" | "missingApproval" | "rejected" | "unknownPackage" | "staleArtifact" | "missingApiHash" | undefined): ApprovalStatus {
    switch (releaseGateReason) {
        case "approved":
            return "approved";
        case "rejected":
            return "rejected";
        default:
            return "revoked";
    }
}

async function handlePullRequestWebhookEvent(deliveryId: string, githubRepositoryId: number, payload: GitHubWebhookPayload): Promise<void> {
    if (!payload.action || !payload.pull_request?.number) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "invalidPullRequestPayload",
            eventType: "pull_request",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber: payload.pull_request?.number,
        });
        return;
    }

    const labelName = payload.label?.name;
    if ((payload.action === "labeled" || payload.action === "unlabeled") && labelName && isApiApprovalManagedLabel(labelName)) {
        await handleManagedApiApprovalLabelWebhookEvent({
            eventType: "pull_request",
            deliveryId,
            githubRepositoryId,
            payload,
            pullRequestNumber: payload.pull_request.number,
            labelName,
            action: payload.action,
        });
        return;
    }

    const pullRequestStatus = getPullRequestStatusFromWebhookPayload(payload.action, payload.pull_request);
    if (!pullRequestStatus) {
        logRequest("POST /api/github/webhook-events ignored", {
            reason: "unsupportedPullRequestAction",
            eventType: "pull_request",
            deliveryId,
            githubRepositoryId,
            action: payload.action,
            pullRequestNumber: payload.pull_request.number,
        });
        return;
    }

    const updatedRecord = await updateReviewPullRequestStatus(githubRepositoryId, payload.pull_request.number, pullRequestStatus);
    if (updatedRecord && isTerminalPullRequestStatus(pullRequestStatus)) {
        await cleanupReviewPullRequestBranches(deliveryId, githubRepositoryId, updatedRecord);
    }

    console.log(JSON.stringify({
        event: updatedRecord ? "reviewPullRequestWebhookApplied" : "pullRequestWebhookIgnoredForNonReviewPullRequest",
        deliveryId,
        githubRepositoryId,
        action: payload.action,
        pullRequestNumber: payload.pull_request.number,
        pullRequestStatus,
    }));
}

async function cleanupReviewPullRequestBranches(
    deliveryId: string,
    githubRepositoryId: number,
    reviewPullRequest: ReviewPullRequestRecord,
): Promise<void> {
    const repository = parseRepositoryFullName(reviewPullRequest.repositoryFullName);
    if (!repository) {
        console.warn(JSON.stringify({
            event: "reviewPullRequestBranchCleanupSkippedForInvalidRepositoryFullName",
            deliveryId,
            githubRepositoryId,
            repositoryFullName: reviewPullRequest.repositoryFullName,
            pullRequestNumber: reviewPullRequest.pullRequestNumber,
        }));
        return;
    }

    if (!isApiReviewBranch(reviewPullRequest.reviewBranch, "review") || !isApiReviewBranch(reviewPullRequest.baseBranch, "base")) {
        console.warn(JSON.stringify({
            event: "reviewPullRequestBranchCleanupSkippedForUnexpectedBranchName",
            deliveryId,
            githubRepositoryId,
            pullRequestNumber: reviewPullRequest.pullRequestNumber,
            reviewBranch: reviewPullRequest.reviewBranch,
            baseBranch: reviewPullRequest.baseBranch,
        }));
        return;
    }

    const openBaseBranchReviewPullRequests = await findOpenReviewPullRequestsByBaseBranch(githubRepositoryId, reviewPullRequest.baseBranch);
    const reviewBranchDeleted = await deleteGitBranch({
        owner: repository.owner,
        repo: repository.repo,
        branch: reviewPullRequest.reviewBranch,
    });
    const baseBranchDeleted = openBaseBranchReviewPullRequests.length === 0
        ? await deleteGitBranch({
            owner: repository.owner,
            repo: repository.repo,
            branch: reviewPullRequest.baseBranch,
        })
        : false;

    console.log(JSON.stringify({
        event: "reviewPullRequestBranchesCleanedUp",
        deliveryId,
        githubRepositoryId,
        pullRequestNumber: reviewPullRequest.pullRequestNumber,
        reviewBranch: reviewPullRequest.reviewBranch,
        reviewBranchDeleted,
        baseBranch: reviewPullRequest.baseBranch,
        baseBranchDeleted,
        openBaseBranchReviewPullRequestCount: openBaseBranchReviewPullRequests.length,
        openBaseBranchPullRequestNumbers: openBaseBranchReviewPullRequests.map((record) => record.pullRequestNumber),
    }));
}

function getBranchNameFromGitRef(ref: string | undefined): string | undefined {
    const prefix = "refs/heads/";
    return ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

function getChangedFilesFromPushPayload(payload: GitHubWebhookPayload): string[] {
    const files = new Set<string>();
    const commits = payload.commits?.length ? payload.commits : payload.head_commit ? [payload.head_commit] : [];
    for (const commit of commits) {
        for (const file of [...commit.added ?? [], ...commit.modified ?? [], ...commit.removed ?? []]) {
            if (file) {
                files.add(file.replace(/\\/g, "/"));
            }
        }
    }

    return [...files];
}

function getChangedPackageNames(files: string[]): Set<string> {
    const packageNames = new Set<string>();
    for (const file of files) {
        const segments = file.split("/").filter((segment) => segment.length > 0);
        if (segments.length >= 3 && segments[0] === "sdk") {
            packageNames.add(segments[2]);
        }
    }

    return packageNames;
}

function getPullRequestStatusFromWebhookPayload(
    action: string,
    pullRequest: NonNullable<GitHubWebhookPayload["pull_request"]>,
): ReviewPullRequestStatus | undefined {
    if (action === "closed") {
        return pullRequest.merged ? "merged" : "closed";
    }

    if (action === "converted_to_draft") {
        return "draft";
    }

    if (action === "opened" || action === "reopened" || action === "ready_for_review" || action === "synchronize") {
        return pullRequest.draft ? "draft" : "open";
    }

    if (pullRequest.state === "open") {
        return pullRequest.draft ? "draft" : "open";
    }

    return undefined;
}

function isTerminalPullRequestStatus(status: ReviewPullRequestStatus): boolean {
    return status === "closed" || status === "merged";
}

function isApiReviewBranch(branch: string, kind: "base" | "review"): boolean {
    return branch.startsWith(`apireview/${kind}_`);
}

function getPullRequestReviewApprovalStatus(action: string, reviewState: string | undefined): ApprovalStatus | undefined {
    const normalizedState = reviewState?.toLowerCase();

    if (action === "dismissed" || normalizedState === "dismissed" || normalizedState === "stale") {
        return "revoked";
    }

    if (action !== "submitted") {
        return undefined;
    }

    switch (normalizedState) {
        case "approved":
            return "approved";
        case "changes_requested":
            return "rejected";
        default:
            return undefined;
    }
}

function parseRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } | undefined {
    const [owner, repo] = repositoryFullName.split("/", 2);
    return owner && repo ? { owner, repo } : undefined;
}

function logRejectedWebhookDelivery(
    reason: string,
    eventType: string | undefined,
    deliveryId: string | undefined,
    signatureSha256: string | undefined,
    contentType: string | undefined,
    payloadBytes: number,
): void {
    logRequest("POST /api/github/webhook-events rejected", {
        reason,
        eventType,
        deliveryId,
        hasSignatureSha256: Boolean(signatureSha256),
        contentType,
        payloadBytes,
    });
}

function logWebhookRegistrationError(
    reason: string,
    eventType: string,
    deliveryId: string,
    contentType: string | undefined,
    payloadBytes: number,
    githubRepositoryId: number,
    githubWebhookId: number,
): void {
    console.error(
        JSON.stringify({
            endpoint: "POST /api/github/webhook-events rejected",
            reason,
            eventType,
            deliveryId,
            contentType,
            payloadBytes,
            githubRepositoryId,
            githubWebhookId,
        }),
    );
}

async function validateGitHubSignature(
    signatureSha256: string,
    payload: Buffer,
    repositoryRegistration: RepositoryRegistration,
): Promise<GitHubSignatureValidationResult> {
    const expectedSignature = parseGitHubSha256Signature(signatureSha256);
    if (!expectedSignature) {
        return {
            valid: false,
            result: "invalidSignatureFormat",
            failureReason: "The GitHub webhook signature header is not a valid sha256 signature.",
        };
    }

    const webhookSecretKeys = [
        { name: repositoryRegistration.webhookSecretKey, role: "current" },
        { name: repositoryRegistration.lastWebhookSecretKey, role: "previous" },
    ] satisfies WebhookSecretKey[];
    const failedSecretKeys: WebhookSecretLookupResult[] = [];
    let usableSecretCount = 0;

    for (const webhookSecretKey of webhookSecretKeys) {
        const secret = await getWebhookSecret(webhookSecretKey);
        if (!secret.value) {
            failedSecretKeys.push(secret);
            continue;
        }
        usableSecretCount++;
        const actualSignature = createHmac("sha256", secret.value).update(payload).digest();

        if (actualSignature.length === expectedSignature.length && timingSafeEqual(actualSignature, expectedSignature)) {
            return { valid: true };
        }

        failedSecretKeys.push({ ...webhookSecretKey, failureReason: "signatureMismatch" });
    }

    console.error(
        JSON.stringify({
            endpoint: "POST /api/github/webhook-events rejected",
            reason: "invalidWebhookSecret",
            failedSecretKeys: failedSecretKeys.map(toWebhookSecretFailureLog),
        }),
    );

    if (usableSecretCount === 0) {
        return {
            valid: false,
            result: "unusableWebhookSecret",
            failureReason: `No registered webhook secret is currently usable: ${getWebhookSecretFailureSummary(failedSecretKeys)}.`,
        };
    }

    return {
        valid: false,
        result: "invalidSignature",
        failureReason: "The GitHub webhook signature did not match any usable registered repository secret.",
    };
}

function getWebhookSecretFailureSummary(secrets: WebhookSecretLookupResult[]): string {
    return secrets.map((secret) => `${secret.role}:${secret.failureReason ?? "unknown"}`).join(", ");
}

function toWebhookSecretFailureLog(secret: WebhookSecretLookupResult): Record<string, unknown> {
    return {
        role: secret.role,
        failureReason: secret.failureReason,
        enabled: secret.enabled,
        expiresOn: secret.expiresOn,
        notBefore: secret.notBefore,
    };
}

function parseGitHubSha256Signature(signatureSha256: string): Buffer | undefined {
    const prefix = "sha256=";
    if (!signatureSha256.startsWith(prefix)) {
        return undefined;
    }

    const signatureHex = signatureSha256.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/i.test(signatureHex)) {
        return undefined;
    }

    return Buffer.from(signatureHex, "hex");
}

async function getWebhookSecret(webhookSecretKey: WebhookSecretKey): Promise<WebhookSecretLookupResult> {
    const keyVaultUri = await getRequiredSetting("keyvault_uri");
    secretClient ??= new SecretClient(keyVaultUri, credential);
    const secret = await getKeyVaultSecret(webhookSecretKey.name);

    if (!secret) {
        return { ...webhookSecretKey, failureReason: "notFound" };
    }

    const unusableReason = getWebhookSecretUnusableReason(secret);
    if (unusableReason) {
        return { ...webhookSecretKey, ...getWebhookSecretProperties(secret), failureReason: unusableReason };
    }

    if (!secret.value) {
        return { ...webhookSecretKey, ...getWebhookSecretProperties(secret), failureReason: "missingValue" };
    }

    return { ...webhookSecretKey, ...getWebhookSecretProperties(secret), value: secret.value };
}

function getWebhookSecretProperties(secret: KeyVaultSecret): Pick<WebhookSecretLookupResult, "enabled" | "expiresOn" | "notBefore"> {
    return {
        enabled: secret.properties.enabled,
        expiresOn: secret.properties.expiresOn?.toISOString(),
        notBefore: secret.properties.notBefore?.toISOString(),
    };
}

function getWebhookSecretUnusableReason(secret: KeyVaultSecret): string | undefined {
    const now = Date.now();

    if (secret.properties.enabled === false) {
        return "disabled";
    }
    if (secret.properties.expiresOn && secret.properties.expiresOn.getTime() <= now) {
        return "expired";
    }
    if (secret.properties.notBefore && secret.properties.notBefore.getTime() > now) {
        return "notBefore";
    }

    return undefined;
}

async function getKeyVaultSecret(webhookSecretKey: string): Promise<KeyVaultSecret | undefined> {
    try {
        return await secretClient!.getSecret(webhookSecretKey);
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }

        throw error;
    }
}

function isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

interface RepositoryRegistrationQueryOptions {
    readonly includeDeleted?: boolean;
}

async function getRepositoryRegistration(
    githubRepositoryId: number,
    options: RepositoryRegistrationQueryOptions = {},
): Promise<RepositoryRegistration | undefined> {
    const container = await getRepositoryRegistrationsContainer();
    try {
        const response = await container.item(String(githubRepositoryId), githubRepositoryId).read<RepositoryRegistration>();
        return isDeletedRepositoryRegistrationHidden(response.resource, options) ? undefined : response.resource;
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }

        throw error;
    }
}

async function getRepositoryRegistrationsContainer(): Promise<Container> {
    if (repositoryRegistrationsContainer) {
        return repositoryRegistrationsContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    repositoryRegistrationsContainer = cosmosClient.database(cosmosDatabaseName).container(repositoryRegistrationsContainerName);
    return repositoryRegistrationsContainer;
}

function parseGitHubId(value: string): number | undefined {
    if (!/^\d+$/.test(value)) {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isDeletedRepositoryRegistrationHidden(
    record: RepositoryRegistration | undefined,
    options: RepositoryRegistrationQueryOptions,
): boolean {
    return !options.includeDeleted && record?.deletedOn !== undefined;
}

function decodeGitHubWebhookPayload(payload: Buffer, contentType: string | undefined): GitHubWebhookPayload | undefined {
    const payloadText = payload.toString("utf8");

    try {
        if (contentType?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
            const formPayload = new URLSearchParams(payloadText).get("payload");
            return formPayload ? parseGitHubWebhookPayloadJson(formPayload) : undefined;
        }

        return parseGitHubWebhookPayloadJson(payloadText);
    } catch {
        return undefined;
    }
}

function parseGitHubWebhookPayloadJson(payloadJson: string): GitHubWebhookPayload | undefined {
    const value = JSON.parse(payloadJson);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as GitHubWebhookPayload) : undefined;
}

function truncateLogValue(value: string | undefined): string | undefined {
    if (!value || value.length <= maxLoggedCommentBodyLength) {
        return value;
    }

    return `${value.slice(0, maxLoggedCommentBodyLength)}...`;
}