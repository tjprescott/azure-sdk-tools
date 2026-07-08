import { CosmosClient, type Container, type PartitionKey } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";

const credential = new DefaultAzureCredential();
const cleanupIntervalMs = 24 * 60 * 60 * 1000;
const oneDayMs = 24 * 60 * 60 * 1000;

let cosmosClient: CosmosClient | undefined;
let cleanupInProgress = false;

interface RetentionPolicy {
    readonly containerName: string;
    readonly retentionSettingKey: string;
    readonly partitionKeyProperty: string;
}

interface DeletedRecordReference {
    readonly id: string;
    readonly partitionKey: PartitionKey;
    readonly deletedOn: string;
}

const retentionPolicies: readonly RetentionPolicy[] = [
    { containerName: "approvalRecords", retentionSettingKey: "retention:approvalRecords:days", partitionKeyProperty: "packageVersionKey" },
    { containerName: "services", retentionSettingKey: "retention:services:days", partitionKeyProperty: "id" },
    { containerName: "packages", retentionSettingKey: "retention:packages:days", partitionKeyProperty: "language" },
    { containerName: "packageVersions", retentionSettingKey: "retention:packageVersions:days", partitionKeyProperty: "packageId" },
    { containerName: "repositoryRegistrations", retentionSettingKey: "retention:repositoryRegistrations:days", partitionKeyProperty: "githubRepositoryId" },
    { containerName: "reviewPullRequests", retentionSettingKey: "retention:reviewPullRequests:days", partitionKeyProperty: "githubRepositoryId" },
    { containerName: "adoOperations", retentionSettingKey: "retention:adoOperations:days", partitionKeyProperty: "operationId" },
    { containerName: "webhookEvents", retentionSettingKey: "retention:webhookEvents:days", partitionKeyProperty: "githubRepositoryId" },
];

export function startRetentionCleanupJob(): void {
    void runRetentionCleanupSafely();
    setInterval(() => {
        void runRetentionCleanupSafely();
    }, cleanupIntervalMs).unref();
}

export async function runRetentionCleanup(): Promise<void> {
    const startedOn = new Date().toISOString();
    let deletedCount = 0;

    for (const policy of retentionPolicies) {
        deletedCount += await runContainerRetentionCleanup(policy);
    }

    console.log(JSON.stringify({
        event: "retentionCleanupCompleted",
        startedOn,
        completedOn: new Date().toISOString(),
        deletedCount,
    }));
}

async function runRetentionCleanupSafely(): Promise<void> {
    if (cleanupInProgress) {
        console.log(JSON.stringify({ event: "retentionCleanupSkipped", reason: "alreadyRunning" }));
        return;
    }

    cleanupInProgress = true;
    try {
        await runRetentionCleanup();
    } catch (error) {
        console.error(JSON.stringify({
            event: "retentionCleanupFailed",
            error: error instanceof Error ? error.message : String(error),
        }));
    } finally {
        cleanupInProgress = false;
    }
}

async function runContainerRetentionCleanup(policy: RetentionPolicy): Promise<number> {
    const retentionDays = await getRetentionDays(policy.retentionSettingKey);
    const cutoff = new Date(Date.now() - retentionDays * oneDayMs).toISOString();
    const container = await getContainer(policy.containerName);
    const expiredRecords = await findExpiredDeletedRecords(container, policy, cutoff);
    let deletedCount = 0;

    for (const record of expiredRecords) {
        if (await deleteExpiredRecord(container, policy, record)) {
            deletedCount++;
        }
    }

    console.log(JSON.stringify({
        event: "retentionContainerCleanupCompleted",
        containerName: policy.containerName,
        retentionDays,
        cutoff,
        expiredCount: expiredRecords.length,
        deletedCount,
    }));
    return deletedCount;
}

async function findExpiredDeletedRecords(
    container: Container,
    policy: RetentionPolicy,
    cutoff: string,
): Promise<DeletedRecordReference[]> {
    const response = await container.items.query<DeletedRecordReference>({
        query: `
            SELECT c.id, c.${policy.partitionKeyProperty} AS partitionKey, c.deletedOn
            FROM c
            WHERE IS_DEFINED(c.deletedOn)
                AND c.deletedOn <= @cutoff
        `,
        parameters: [
            { name: "@cutoff", value: cutoff },
        ],
    }).fetchAll();

    return response.resources;
}

async function deleteExpiredRecord(container: Container, policy: RetentionPolicy, record: DeletedRecordReference): Promise<boolean> {
    try {
        await container.item(record.id, record.partitionKey).delete();
        console.log(JSON.stringify({
            event: "retentionRecordHardDeleted",
            containerName: policy.containerName,
            id: record.id,
            deletedOn: record.deletedOn,
        }));
        return true;
    } catch (error) {
        if (isCosmosNotFoundError(error)) {
            return false;
        }

        throw error;
    }
}

async function getRetentionDays(settingKey: string): Promise<number> {
    const value = await getRequiredSetting(settingKey);
    const retentionDays = Number(value);

    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        throw new Error(`Retention setting ${settingKey} must be a positive integer number of days.`);
    }

    return retentionDays;
}

async function getContainer(containerName: string): Promise<Container> {
    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    return cosmosClient.database(cosmosDatabaseName).container(containerName);
}

function isCosmosNotFoundError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === 404;
}
