import { randomUUID } from "node:crypto";

import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import { getRequiredSetting } from "../config/settings.js";

const credential = new DefaultAzureCredential();
const packagesContainerName = "packages";
const packageVersionsContainerName = "packageVersions";

let cosmosClient: CosmosClient | undefined;
let packagesContainer: Container | undefined;
let packageVersionsContainer: Container | undefined;

export interface PackageRecord {
    readonly id: string;
    readonly language: string;
    readonly packageName: string;
    readonly createdOn: string;
    readonly lastUpdatedOn: string;
    readonly deletedOn?: string;
}

export interface PackageVersionRecord {
    readonly id: string;
    readonly packageId: string;
    readonly version: string;
    readonly kind: PackageVersionKind;
    readonly createdOn: string;
    readonly lastUpdatedOn: string;
    readonly releasedOn?: string;
    readonly deletedOn?: string;
}

export type PackageVersionKind = "stable" | "preview";

interface RecordQueryOptions {
    readonly includeDeleted?: boolean;
}

export interface UpsertPackageVersionRequest {
    readonly language: string;
    readonly packageName: string;
    readonly version: string;
}

export interface UpsertPackageVersionResult {
    readonly package: PackageRecord;
    readonly packageVersion: PackageVersionRecord;
}

export async function upsertPackageVersion(request: UpsertPackageVersionRequest): Promise<UpsertPackageVersionResult> {
    const packageRecord = await upsertPackage(request.language, request.packageName);
    const packageVersion = await upsertPackageVersionRecord(packageRecord, request.version);
    return { package: packageRecord, packageVersion };
}

export async function markPackageVersionReleased(language: string, packageName: string, version: string, releasedOn: string): Promise<PackageVersionRecord | undefined> {
    const packagesContainer = await getPackagesContainer();
    const packageRecord = await findPackageRecord(packagesContainer, language, packageName);
    if (!packageRecord) {
        return undefined;
    }

    const packageVersionsContainer = await getPackageVersionsContainer();
    const existingRecord = await findPackageVersionRecord(packageVersionsContainer, packageRecord.id, version);
    if (!existingRecord) {
        return undefined;
    }

    const updatedRecord: PackageVersionRecord = {
        ...existingRecord,
        releasedOn,
        lastUpdatedOn: new Date().toISOString(),
    };
    await packageVersionsContainer.items.upsert(updatedRecord);
    console.log(JSON.stringify({
        event: "packageVersionMarkedReleased",
        packageVersionId: updatedRecord.id,
        packageId: updatedRecord.packageId,
        version: updatedRecord.version,
        releasedOn: updatedRecord.releasedOn,
    }));
    return updatedRecord;
}

async function upsertPackage(language: string, packageName: string): Promise<PackageRecord> {
    const now = new Date().toISOString();
    const container = await getPackagesContainer();
    const existingRecord = await findPackageRecord(container, language, packageName, { includeDeleted: true });
    const record: PackageRecord = {
        id: existingRecord?.id ?? randomUUID(),
        language,
        packageName,
        createdOn: existingRecord?.createdOn ?? now,
        lastUpdatedOn: now,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: existingRecord ? "packageRecordUpdated" : "packageRecordCreated",
        packageId: record.id,
        language: record.language,
        packageName: record.packageName,
    }));
    return record;
}

async function upsertPackageVersionRecord(packageRecord: PackageRecord, version: string): Promise<PackageVersionRecord> {
    const now = new Date().toISOString();
    const container = await getPackageVersionsContainer();
    const existingRecord = await findPackageVersionRecord(container, packageRecord.id, version, { includeDeleted: true });
    const record: PackageVersionRecord = {
        id: existingRecord?.id ?? randomUUID(),
        packageId: packageRecord.id,
        version,
        kind: existingRecord?.kind ?? getPackageVersionKind(version),
        createdOn: existingRecord?.createdOn ?? now,
        lastUpdatedOn: now,
        releasedOn: existingRecord?.releasedOn,
    };

    await container.items.upsert(record);
    console.log(JSON.stringify({
        event: existingRecord ? "packageVersionRecordUpdated" : "packageVersionRecordCreated",
        packageVersionId: record.id,
        packageId: record.packageId,
        version: record.version,
        kind: record.kind,
    }));
    return record;
}

async function findPackageRecord(
    container: Container,
    language: string,
    packageName: string,
    options: RecordQueryOptions = {},
): Promise<PackageRecord | undefined> {
    const response = await container.items.query<PackageRecord>({
        query: `
            SELECT * FROM packages p
            WHERE p.language = @language
                AND p.packageName = @packageName
                ${getDeletedRecordFilter("p", options)}
        `,
        parameters: [
            { name: "@language", value: language },
            { name: "@packageName", value: packageName },
        ],
    }).fetchAll();

    return response.resources[0];
}

async function findPackageVersionRecord(
    container: Container,
    packageId: string,
    version: string,
    options: RecordQueryOptions = {},
): Promise<PackageVersionRecord | undefined> {
    const response = await container.items.query<PackageVersionRecord>({
        query: `
            SELECT * FROM packageVersions pv
            WHERE pv.packageId = @packageId
                AND pv.version = @version
                ${getDeletedRecordFilter("pv", options)}
        `,
        parameters: [
            { name: "@packageId", value: packageId },
            { name: "@version", value: version },
        ],
    }).fetchAll();

    return response.resources[0];
}

async function getPackagesContainer(): Promise<Container> {
    if (packagesContainer) {
        return packagesContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    packagesContainer = cosmosClient.database(cosmosDatabaseName).container(packagesContainerName);
    return packagesContainer;
}

async function getPackageVersionsContainer(): Promise<Container> {
    if (packageVersionsContainer) {
        return packageVersionsContainer;
    }

    const cosmosEndpoint = await getRequiredSetting("cosmos_endpoint");
    const cosmosDatabaseName = await getRequiredSetting("cosmos_db_name");
    cosmosClient ??= new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    packageVersionsContainer = cosmosClient.database(cosmosDatabaseName).container(packageVersionsContainerName);
    return packageVersionsContainer;
}

function getPackageVersionKind(version: string): PackageVersionKind {
    return /(?:^|[.-])(?:alpha|beta|preview|rc|dev)\d*(?:[.-]|$)|\d(?:a|b|rc)\d+$/i.test(version) ? "preview" : "stable";
}

function getDeletedRecordFilter(alias: string, options: RecordQueryOptions): string {
    return options.includeDeleted ? "" : `AND NOT IS_DEFINED(${alias}.deletedOn)`;
}

