import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";

const credential = new DefaultAzureCredential();
const webhookEventsContainerName = "webhookEvents";

let cosmosClient: CosmosClient | undefined;
let webhookEventsContainer: Container | undefined;

export type WebhookEventStatus = "accepted" | "processing" | "processed" | "ignored" | "failed" | "rejected";

interface RecordQueryOptions {
    readonly includeDeleted?: boolean;
}

export interface WebhookEventRecord {
    readonly id: string;
    readonly deliveryId: string;
    readonly githubRepositoryId: number;
    readonly githubWebhookId?: number;
    readonly repositoryFullName?: string;
    readonly repositoryName?: string;
    readonly eventType: string;
    readonly contentType?: string;
    readonly action?: string;
    readonly sender?: string;
    readonly pullRequestNumber?: number;
    readonly reviewId?: number;
    readonly ref?: string;
    readonly before?: string;
    readonly after?: string;
    readonly status: WebhookEventStatus;
    readonly result?: string;
    readonly failureReason?: string;
    readonly receivedOn: string;
    readonly startedOn?: string;
    readonly completedOn?: string;
    readonly lastUpdatedOn: string;
    readonly deletedOn?: string;
}

export interface CreateWebhookEventRecordRequest {
    readonly deliveryId: string;
    readonly githubRepositoryId: number;
    readonly githubWebhookId?: number;
    readonly repositoryFullName?: string;
    readonly eventType: string;
    readonly contentType?: string;
    readonly action?: string;
    readonly sender?: string;
    readonly pullRequestNumber?: number;
    readonly reviewId?: number;
    readonly ref?: string;
    readonly before?: string;
    readonly after?: string;
    readonly status: WebhookEventStatus;
    readonly result?: string;
    readonly failureReason?: string;
}

export interface UpdateWebhookEventRecordRequest {
    readonly deliveryId: string;
    readonly githubRepositoryId: number;
    readonly status: WebhookEventStatus;
    readonly result?: string;
    readonly failureReason?: string;
}

export async function tryCreateWebhookEventRecord(request: CreateWebhookEventRecordRequest): Promise<WebhookEventRecord | undefined> {
    const now = new Date().toISOString();
    const completedOn = isTerminalWebhookEventStatus(request.status) ? now : undefined;
    const record: WebhookEventRecord = {
        id: request.deliveryId,
        deliveryId: request.deliveryId,
        githubRepositoryId: request.githubRepositoryId,
        githubWebhookId: request.githubWebhookId,
        repositoryFullName: request.repositoryFullName,
        repositoryName: getRepositoryName(request.repositoryFullName),
        eventType: request.eventType,
        contentType: request.contentType,
        action: request.action,
        sender: request.sender,
        pullRequestNumber: request.pullRequestNumber,
        reviewId: request.reviewId,
        ref: request.ref,
        before: request.before,
        after: request.after,
        status: request.status,
        result: request.result,
        failureReason: request.failureReason,
        receivedOn: now,
        completedOn,
        lastUpdatedOn: now,
        deletedOn: completedOn,
    };

    const container = await getWebhookEventsContainer();
    try {
        await container.items.create(record);
    } catch (error) {
        if (isCosmosConflictError(error)) {
            return undefined;
        }

        throw error;
    }

    console.log(JSON.stringify({
        event: "webhookEventRecordCreated",
        deliveryId: record.deliveryId,
        githubRepositoryId: record.githubRepositoryId,
        githubWebhookId: record.githubWebhookId,
        repositoryFullName: record.repositoryFullName,
        eventType: record.eventType,
        action: record.action,
        status: record.status,
        result: record.result,
    }));
    return record;
}

export async function updateWebhookEventRecord(request: UpdateWebhookEventRecordRequest): Promise<WebhookEventRecord | undefined> {
    const container = await getWebhookEventsContainer();
    const existingRecord = await readWebhookEventRecord(container, request.deliveryId, request.githubRepositoryId);
    if (!existingRecord) {
        return undefined;
    }

    const now = new Date().toISOString();
    const completedOn = isTerminalWebhookEventStatus(request.status) ? existingRecord.completedOn ?? now : existingRecord.completedOn;
    const record: WebhookEventRecord = {
        ...existingRecord,
        status: request.status,
        result: request.result,
        failureReason: request.failureReason,
        startedOn: existingRecord.startedOn ?? (request.status === "processing" ? now : existingRecord.startedOn),
        completedOn,
        lastUpdatedOn: now,
        deletedOn: completedOn ? existingRecord.deletedOn ?? now : existingRecord.deletedOn,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: "webhookEventRecordUpdated",
        deliveryId: record.deliveryId,
        githubRepositoryId: record.githubRepositoryId,
        eventType: record.eventType,
        action: record.action,
        status: record.status,
        result: record.result,
    }));
    return record;
}

async function readWebhookEventRecord(
    container: Container,
    deliveryId: string,
    githubRepositoryId: number,
    options: RecordQueryOptions = {},
): Promise<WebhookEventRecord | undefined> {
    try {
        const response = await container.item(deliveryId, githubRepositoryId).read<WebhookEventRecord>();
        return isDeletedRecordHidden(response.resource, options) ? undefined : response.resource;
    } catch (error) {
        if (isCosmosNotFoundError(error)) {
            return undefined;
        }

        throw error;
    }
}

async function getWebhookEventsContainer(): Promise<Container> {
    if (webhookEventsContainer) {
        return webhookEventsContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    webhookEventsContainer = cosmosClient.database(cosmosDatabaseName).container(webhookEventsContainerName);
    return webhookEventsContainer;
}

function isTerminalWebhookEventStatus(status: WebhookEventStatus): boolean {
    return status === "processed" || status === "ignored" || status === "failed" || status === "rejected";
}

function getRepositoryName(repositoryFullName: string | undefined): string | undefined {
    return repositoryFullName?.split("/", 2)[1];
}

function isCosmosConflictError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === 409;
}

function isCosmosNotFoundError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === 404;
}

function isDeletedRecordHidden(record: WebhookEventRecord | undefined, options: RecordQueryOptions): boolean {
    return !options.includeDeleted && record?.deletedOn !== undefined;
}
