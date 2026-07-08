import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";
import type { OperationStatus, ReviewPullRequestCreationRequest } from "../models/models.js";
import type { ReviewPullRequestRecord } from "./review-pr-store.js";

const credential = new DefaultAzureCredential();
const adoOperationsContainerName = "adoOperations";

let cosmosClient: CosmosClient | undefined;
let adoOperationsContainer: Container | undefined;

export interface AdoOperationRecord extends OperationStatus {
    readonly id: string;
    readonly queuedReason: AdoOperationQueuedReason;
    readonly creationRequest?: ReviewPullRequestCreationRequest;
    readonly updateRequest?: AdoOperationUpdateRequest;
    readonly createdOn: string;
    readonly lastUpdatedOn: string;
    readonly completedOn?: string;
    readonly deletedOn?: string;
}

export type AdoOperationQueuedReason = "createReviewPullRequest" | "updateReviewPullRequest";

export interface RecordQueryOptions {
    readonly includeDeleted?: boolean;
}

export interface AdoOperationUpdateRequest {
    readonly reviewPullRequest: ReviewPullRequestRecord;
    readonly targetRef: string;
}

export interface SaveAdoOperationRequest extends OperationStatus {
    readonly queuedReason: AdoOperationQueuedReason;
    readonly creationRequest?: ReviewPullRequestCreationRequest;
    readonly updateRequest?: AdoOperationUpdateRequest;
}

export async function saveAdoOperation(request: SaveAdoOperationRequest): Promise<AdoOperationRecord> {
    const now = new Date().toISOString();
    const container = await getAdoOperationsContainer();
    const existingRecord = await readAdoOperationRecord(container, request.operationId, { includeDeleted: true });
    const record: AdoOperationRecord = {
        ...existingRecord,
        ...request,
        id: request.operationId,
        queuedReason: request.queuedReason,
        createdOn: existingRecord?.createdOn ?? now,
        lastUpdatedOn: now,
        completedOn: isTerminalOperationStatus(request.status) ? existingRecord?.completedOn ?? now : existingRecord?.completedOn,
        deletedOn: existingRecord?.deletedOn,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: existingRecord ? "adoOperationRecordUpdated" : "adoOperationRecordCreated",
        operationId: record.operationId,
        status: record.status,
        queuedReason: record.queuedReason,
        pipelineProject: record.pipelineProject,
        pipelineId: record.pipelineId,
        buildId: record.buildId,
    }));
    return record;
}

export async function getAdoOperation(operationId: string, options: RecordQueryOptions = {}): Promise<AdoOperationRecord | undefined> {
    const container = await getAdoOperationsContainer();
    return readAdoOperationRecord(container, operationId, options);
}

export function toOperationStatus(record: AdoOperationRecord): OperationStatus {
    return {
        operationId: record.operationId,
        status: record.status,
        mode: record.mode,
        language: record.language,
        packageName: record.packageName,
        pipelineProject: record.pipelineProject,
        pipelineId: record.pipelineId,
        buildId: record.buildId,
        pipelineUrl: record.pipelineUrl,
        reviewPullRequest: record.reviewPullRequest,
        failureReason: record.failureReason,
        log: record.log,
    };
}

export async function findOutstandingAdoOperations(options: RecordQueryOptions = {}): Promise<AdoOperationRecord[]> {
    const container = await getAdoOperationsContainer();
    const response = await container.items.query<AdoOperationRecord>({
        query: `
            SELECT * FROM adoOperations op
            WHERE op.status IN ("accepted", "running")
                ${getDeletedRecordFilter("op", options)}
        `,
    }).fetchAll();

    return response.resources;
}

export async function softDeleteCompletedAdoOperation(operationId: string): Promise<AdoOperationRecord | undefined> {
    const container = await getAdoOperationsContainer();
    const existingRecord = await readAdoOperationRecord(container, operationId, { includeDeleted: true });
    if (!existingRecord) {
        return undefined;
    }

    const now = new Date().toISOString();
    const record: AdoOperationRecord = {
        ...existingRecord,
        completedOn: existingRecord.completedOn ?? now,
        deletedOn: existingRecord.deletedOn ?? now,
        lastUpdatedOn: now,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: "adoOperationRecordSoftDeleted",
        operationId: record.operationId,
        status: record.status,
        completedOn: record.completedOn,
        deletedOn: record.deletedOn,
    }));
    return record;
}

async function readAdoOperationRecord(
    container: Container,
    operationId: string,
    options: RecordQueryOptions = {},
): Promise<AdoOperationRecord | undefined> {
    try {
        const response = await container.item(operationId, operationId).read<AdoOperationRecord>();
        return isDeletedRecordHidden(response.resource, options) ? undefined : response.resource;
    } catch (error) {
        if (isCosmosNotFoundError(error)) {
            return undefined;
        }

        throw error;
    }
}

async function getAdoOperationsContainer(): Promise<Container> {
    if (adoOperationsContainer) {
        return adoOperationsContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    adoOperationsContainer = cosmosClient.database(cosmosDatabaseName).container(adoOperationsContainerName);
    return adoOperationsContainer;
}

function isTerminalOperationStatus(status: OperationStatus["status"]): boolean {
    return status === "succeeded" || status === "failed";
}

function isCosmosNotFoundError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === 404;
}

function isDeletedRecordHidden(record: AdoOperationRecord | undefined, options: RecordQueryOptions): boolean {
    return !options.includeDeleted && record?.deletedOn !== undefined;
}

function getDeletedRecordFilter(alias: string, options: RecordQueryOptions): string {
    return options.includeDeleted ? "" : `AND NOT IS_DEFINED(${alias}.deletedOn)`;
}