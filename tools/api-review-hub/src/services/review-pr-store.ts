import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";
import type { PublishedApiReviewPullRequest } from "../github/repository-actions.js";

const credential = new DefaultAzureCredential();
const reviewPullRequestsContainerName = "reviewPullRequests";

let cosmosClient: CosmosClient | undefined;
let reviewPullRequestsContainer: Container | undefined;

export interface ReviewPullRequestRecord {
    // Cosmos item id. This is the GitHub pull request number within the githubRepositoryId partition.
    readonly id: string;
    readonly packageVersionId: string;
    readonly language: string;
    readonly packageName: string;
    readonly packageRelativePath: string;
    readonly baseVersion: string;
    readonly targetVersion: string;
    readonly baseRef: string;
    readonly targetRef: string;
    readonly githubRepositoryId: number;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    readonly pullRequestStatus: ReviewPullRequestStatus;
    readonly baseBranch: string;
    readonly reviewBranch: string;
    readonly workingBranch: string;
    readonly operationId: string;
    readonly buildId: string;
    readonly approval: ApprovalRecord;
    readonly createdOn: string;
    readonly lastUpdatedOn: string;
}

export type ReviewPullRequestStatus = "draft" | "open" | "closed" | "merged";
export type ApprovalStatus = "approved" | "rejected" | "revoked" | "pending";

export interface ApprovalRecord {
    readonly packageName: string;
    readonly version: string;
    readonly apiHash: string;
    readonly commitSha?: string;
    readonly status: ApprovalStatus;
    readonly lastUpdatedBy: string;
    readonly lastUpdatedOn: string;
}

export interface SaveReviewPullRequestRecordRequest {
    readonly packageVersionId: string;
    readonly operationId: string;
    readonly buildId: string;
    readonly language: string;
    readonly packageName: string;
    readonly packageRelativePath: string;
    readonly baseVersion: string;
    readonly targetVersion: string;
    readonly baseRef: string;
    readonly targetRef: string;
    readonly apiHash: string;
    readonly workingBranch: string;
    readonly reviewPullRequest: PublishedApiReviewPullRequest;
}

export async function saveReviewPullRequestRecord(request: SaveReviewPullRequestRecordRequest): Promise<ReviewPullRequestRecord> {
    const now = new Date().toISOString();
    const githubRepositoryId = request.reviewPullRequest.repository.id;
    const repositoryFullName = `${request.reviewPullRequest.repository.owner}/${request.reviewPullRequest.repository.repo}`;
    const pullRequestNo = String(request.reviewPullRequest.number);
    const container = await getReviewPullRequestsContainer();
    const existingRecord = await readReviewPullRequestRecord(container, pullRequestNo, githubRepositoryId);
    const record: ReviewPullRequestRecord = {
        id: pullRequestNo,
        packageVersionId: request.packageVersionId,
        language: request.language,
        packageName: request.packageName,
        packageRelativePath: request.packageRelativePath,
        baseVersion: request.baseVersion,
        targetVersion: request.targetVersion,
        baseRef: request.baseRef,
        targetRef: request.targetRef,
        githubRepositoryId,
        repositoryFullName,
        pullRequestNumber: request.reviewPullRequest.number,
        pullRequestUrl: request.reviewPullRequest.url,
        pullRequestStatus: request.reviewPullRequest.status,
        baseBranch: request.reviewPullRequest.baseBranch,
        reviewBranch: request.reviewPullRequest.reviewBranch,
        workingBranch: request.workingBranch,
        operationId: request.operationId,
        buildId: request.buildId,
        approval: existingRecord?.approval ?? createApprovalRecord(request.packageName, request.targetVersion, request.apiHash, "pending", "api-review-hub", now),
        createdOn: existingRecord?.createdOn ?? now,
        lastUpdatedOn: now,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: "reviewPullRequestRecordSaved",
        pullRequestNo,
        packageVersionId: record.packageVersionId,
        operationId: record.operationId,
        pullRequestUrl: record.pullRequestUrl,
    }));
    return record;
}

export async function getReviewPullRequestRecord(
    githubRepositoryId: number,
    pullRequestNumber: number,
): Promise<ReviewPullRequestRecord | undefined> {
    const container = await getReviewPullRequestsContainer();
    return readReviewPullRequestRecord(container, String(pullRequestNumber), githubRepositoryId);
}

export async function findOpenReviewPullRequestsByWorkingBranch(
    githubRepositoryId: number,
    workingBranch: string,
): Promise<ReviewPullRequestRecord[]> {
    const container = await getReviewPullRequestsContainer();
    const response = await container.items.query<ReviewPullRequestRecord>({
        query: `
            SELECT * FROM reviewPullRequests pr
            WHERE pr.githubRepositoryId = @githubRepositoryId
                AND pr.workingBranch = @workingBranch
                AND pr.pullRequestStatus IN ("open", "draft")
        `,
        parameters: [
            { name: "@githubRepositoryId", value: githubRepositoryId },
            { name: "@workingBranch", value: workingBranch },
        ],
    }).fetchAll();

    return response.resources;
}

export async function updateReviewPullRequestStatus(
    githubRepositoryId: number,
    pullRequestNumber: number,
    pullRequestStatus: ReviewPullRequestStatus,
): Promise<ReviewPullRequestRecord | undefined> {
    const container = await getReviewPullRequestsContainer();
    const pullRequestNo = String(pullRequestNumber);
    const existingRecord = await readReviewPullRequestRecord(container, pullRequestNo, githubRepositoryId);

    if (!existingRecord) {
        return undefined;
    }

    if (existingRecord.pullRequestStatus === pullRequestStatus) {
        return existingRecord;
    }

    const updatedRecord: ReviewPullRequestRecord = {
        ...existingRecord,
        pullRequestStatus,
        lastUpdatedOn: new Date().toISOString(),
    };
    await container.items.upsert(updatedRecord);
    console.log(JSON.stringify({
        event: "reviewPullRequestStatusUpdated",
        pullRequestNo,
        githubRepositoryId,
        previousStatus: existingRecord.pullRequestStatus,
        pullRequestStatus: updatedRecord.pullRequestStatus,
    }));

    return updatedRecord;
}

export async function updateReviewPullRequestApprovalStatus(
    githubRepositoryId: number,
    pullRequestNumber: number,
    approvalStatus: ApprovalStatus,
    lastUpdatedBy: string,
    apiHash: string,
    commitSha: string,
): Promise<ReviewPullRequestRecord | undefined> {
    const container = await getReviewPullRequestsContainer();
    const pullRequestNo = String(pullRequestNumber);
    const existingRecord = await readReviewPullRequestRecord(container, pullRequestNo, githubRepositoryId);

    if (!existingRecord) {
        return undefined;
    }

    const previousApproval = existingRecord.approval;
    if (previousApproval?.status === approvalStatus
        && previousApproval.lastUpdatedBy === lastUpdatedBy
        && previousApproval.apiHash === apiHash
        && previousApproval.commitSha === commitSha) {
        return existingRecord;
    }

    const now = new Date().toISOString();
    const approval = createApprovalRecord(
        existingRecord.packageName,
        existingRecord.targetVersion,
        apiHash,
        approvalStatus,
        lastUpdatedBy,
        now,
        commitSha,
    );

    const updatedRecord: ReviewPullRequestRecord = {
        ...existingRecord,
        approval,
        lastUpdatedOn: now,
    };
    await container.items.upsert(updatedRecord);
    console.log(JSON.stringify({
        event: "reviewPullRequestApprovalStatusUpdated",
        pullRequestNo,
        githubRepositoryId,
        previousApprovalStatus: previousApproval?.status,
        approvalStatus: updatedRecord.approval.status,
        apiHash: updatedRecord.approval.apiHash,
        commitSha: updatedRecord.approval.commitSha,
        lastUpdatedBy: updatedRecord.approval.lastUpdatedBy,
    }));

    return updatedRecord;
}

export async function findLatestApprovalRecord(
    language: string,
    packageName: string,
    version: string,
): Promise<ApprovalRecord | undefined> {
    const container = await getReviewPullRequestsContainer();
    const response = await container.items.query<ReviewPullRequestRecord>({
        query: `
            SELECT * FROM reviewPullRequests pr
            WHERE pr.language = @language
                AND pr.packageName = @packageName
                AND pr.targetVersion = @version
        `,
        parameters: [
            { name: "@language", value: language },
            { name: "@packageName", value: packageName },
            { name: "@version", value: version },
        ],
    }).fetchAll();

    return response.resources
        .map((record) => record.approval)
        .filter((approval): approval is ApprovalRecord => approval !== undefined)
        .sort((left, right) => right.lastUpdatedOn.localeCompare(left.lastUpdatedOn))[0];
}

function createApprovalRecord(
    packageName: string,
    version: string,
    apiHash: string,
    status: ApprovalStatus,
    lastUpdatedBy: string,
    lastUpdatedOn: string,
    commitSha?: string,
): ApprovalRecord {
    return {
        packageName,
        version,
        apiHash,
        ...(commitSha ? { commitSha } : {}),
        status,
        lastUpdatedBy,
        lastUpdatedOn,
    };
}

async function readReviewPullRequestRecord(container: Container, pullRequestNo: string, githubRepositoryId: number): Promise<ReviewPullRequestRecord | undefined> {
    try {
        const response = await container.item(pullRequestNo, githubRepositoryId).read<ReviewPullRequestRecord>();
        return response.resource;
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }

        throw error;
    }
}

async function getReviewPullRequestsContainer(): Promise<Container> {
    if (reviewPullRequestsContainer) {
        return reviewPullRequestsContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    reviewPullRequestsContainer = cosmosClient.database(cosmosDatabaseName).container(reviewPullRequestsContainerName);
    return reviewPullRequestsContainer;
}

function isNotFound(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && (("code" in error && error.code === 404) || ("statusCode" in error && error.statusCode === 404));
}