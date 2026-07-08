import { createHash } from "node:crypto";

import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";
import type { ApprovalStatus } from "../models/models.js";
import type { ReviewPullRequestRecord } from "./review-pr-store.js";

const credential = new DefaultAzureCredential();
const approvalRecordsContainerName = "approvalRecords";

let cosmosClient: CosmosClient | undefined;
let approvalRecordsContainer: Container | undefined;

export interface ApprovalRecord {
    readonly id: string;
    readonly packageVersionKey: string;
    readonly language: string;
    readonly packageName: string;
    readonly version: string;
    readonly apiHash: string;
    readonly commitSha?: string;
    readonly status: ApprovalStatus;
    readonly githubRepositoryId: number;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly pullRequestUrl: string;
    readonly reviewBranch: string;
    readonly githubReviewId?: number;
    readonly lastUpdatedBy: string;
    readonly lastUpdatedOn: string;
    readonly createdOn: string;
    readonly deletedOn?: string;
}

export interface UpsertApprovalRecordRequest {
    readonly reviewPullRequest: ReviewPullRequestRecord;
    readonly apiHash: string;
    readonly commitSha?: string;
    readonly status: ApprovalStatus;
    readonly githubReviewId?: number;
    readonly lastUpdatedBy: string;
}

export interface ApprovalRecordQueryOptions {
    readonly includeDeleted?: boolean;
}

export async function upsertApprovalRecord(request: UpsertApprovalRecordRequest): Promise<ApprovalRecord> {
    const now = new Date().toISOString();
    const packageVersionKey = getPackageVersionKey(request.reviewPullRequest.language, request.reviewPullRequest.packageName, request.reviewPullRequest.targetVersion);
    const id = getApprovalRecordId(request, packageVersionKey);
    const container = await getApprovalRecordsContainer();
    const existingRecord = await readApprovalRecord(container, id, packageVersionKey, { includeDeleted: true });
    const record: ApprovalRecord = {
        id,
        packageVersionKey,
        language: request.reviewPullRequest.language,
        packageName: request.reviewPullRequest.packageName,
        version: request.reviewPullRequest.targetVersion,
        apiHash: request.apiHash,
        commitSha: request.commitSha,
        status: request.status,
        githubRepositoryId: request.reviewPullRequest.githubRepositoryId,
        repositoryFullName: request.reviewPullRequest.repositoryFullName,
        pullRequestNumber: request.reviewPullRequest.pullRequestNumber,
        pullRequestUrl: request.reviewPullRequest.pullRequestUrl,
        reviewBranch: request.reviewPullRequest.reviewBranch,
        githubReviewId: request.githubReviewId,
        lastUpdatedBy: request.lastUpdatedBy,
        lastUpdatedOn: now,
        createdOn: existingRecord?.createdOn ?? now,
        deletedOn: existingRecord?.deletedOn,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: existingRecord ? "approvalRecordUpdated" : "approvalRecordCreated",
        approvalRecordId: record.id,
        packageVersionKey: record.packageVersionKey,
        apiHash: record.apiHash,
        status: record.status,
        githubRepositoryId: record.githubRepositoryId,
        pullRequestNumber: record.pullRequestNumber,
        githubReviewId: record.githubReviewId,
        lastUpdatedBy: record.lastUpdatedBy,
    }));
    return record;
}

export async function findLatestApprovalRecordForApiHash(
    language: string,
    packageName: string,
    version: string,
    apiHash: string,
    options: ApprovalRecordQueryOptions = {},
): Promise<ApprovalRecord | undefined> {
    const packageVersionKey = getPackageVersionKey(language, packageName, version);
    const container = await getApprovalRecordsContainer();
    const response = await container.items.query<ApprovalRecord>({
        query: `
            SELECT * FROM approvalRecords ar
            WHERE ar.packageVersionKey = @packageVersionKey
                AND ar.apiHash = @apiHash
                ${getDeletedRecordFilter("ar", options)}
            ORDER BY ar.lastUpdatedOn DESC
        `,
        parameters: [
            { name: "@packageVersionKey", value: packageVersionKey },
            { name: "@apiHash", value: apiHash },
        ],
    }).fetchAll();

    return response.resources[0];
}

function getPackageVersionKey(language: string, packageName: string, version: string): string {
    return `${language}/${packageName}/${version}`;
}

function getApprovalRecordId(request: UpsertApprovalRecordRequest, packageVersionKey: string): string {
    const reviewIdentity = request.githubReviewId === undefined
        ? `${request.reviewPullRequest.githubRepositoryId}:${request.reviewPullRequest.pullRequestNumber}:${request.apiHash}:${request.lastUpdatedBy}`
        : `${request.reviewPullRequest.githubRepositoryId}:${request.reviewPullRequest.pullRequestNumber}:${request.githubReviewId}`;
    return createHash("sha256").update(`${packageVersionKey}:${reviewIdentity}`).digest("hex");
}

async function readApprovalRecord(
    container: Container,
    id: string,
    packageVersionKey: string,
    options: ApprovalRecordQueryOptions = {},
): Promise<ApprovalRecord | undefined> {
    try {
        const response = await container.item(id, packageVersionKey).read<ApprovalRecord>();
        return isDeletedRecordHidden(response.resource, options) ? undefined : response.resource;
    } catch (error) {
        if (isCosmosNotFoundError(error)) {
            return undefined;
        }

        throw error;
    }
}

async function getApprovalRecordsContainer(): Promise<Container> {
    if (approvalRecordsContainer) {
        return approvalRecordsContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    approvalRecordsContainer = cosmosClient.database(cosmosDatabaseName).container(approvalRecordsContainerName);
    return approvalRecordsContainer;
}

function isDeletedRecordHidden(record: ApprovalRecord | undefined, options: ApprovalRecordQueryOptions): boolean {
    return !options.includeDeleted && record?.deletedOn !== undefined;
}

function getDeletedRecordFilter(alias: string, options: ApprovalRecordQueryOptions): string {
    return options.includeDeleted ? "" : `AND NOT IS_DEFINED(${alias}.deletedOn)`;
}

function isCosmosNotFoundError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === 404;
}
