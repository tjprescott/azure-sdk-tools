import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";
import type { RepositoryRegistration } from "../models/models.js";

const credential = new DefaultAzureCredential();
const repositoryRegistrationsContainerName = "repositoryRegistrations";

let cosmosClient: CosmosClient | undefined;
let repositoryRegistrationsContainer: Container | undefined;

export interface RepositoryRegistrationQueryOptions {
    readonly includeDeleted?: boolean;
}

export type StoredRepositoryRegistration = RepositoryRegistration & { readonly id: string };

export async function getRepositoryRegistration(
    githubRepositoryId: number,
    options: RepositoryRegistrationQueryOptions = {},
): Promise<StoredRepositoryRegistration | undefined> {
    const container = await getRepositoryRegistrationsContainer();
    try {
        const response = await container.item(String(githubRepositoryId), githubRepositoryId).read<StoredRepositoryRegistration>();
        return isDeletedRepositoryRegistrationHidden(response.resource, options) ? undefined : response.resource;
    } catch (error) {
        if (isCosmosNotFoundError(error)) {
            return undefined;
        }

        throw error;
    }
}

export async function upsertRepositoryRegistration(registration: StoredRepositoryRegistration): Promise<void> {
    const container = await getRepositoryRegistrationsContainer();
    await container.items.upsert(registration);
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

function isDeletedRepositoryRegistrationHidden(
    record: StoredRepositoryRegistration | undefined,
    options: RepositoryRegistrationQueryOptions,
): boolean {
    return !options.includeDeleted && record?.deletedOn !== undefined;
}

function isCosmosNotFoundError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === 404;
}