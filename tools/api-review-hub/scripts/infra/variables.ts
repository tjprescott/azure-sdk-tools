import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import { load } from "js-yaml";

export type EnvironmentName = "production" | "backup" | "staging";

export interface CosmosContainerConfig {
    readonly name: string;
    readonly partitionKeyPath: string;
}

export interface AppConfigurationSetting {
    readonly key: string;
    readonly value: string;
}

export interface Variables {
    readonly environmentName: EnvironmentName;
    readonly location: string;
    readonly resourceGroupName: string;
    readonly subscriptionId: string;
    readonly tenantId: string;
    readonly appServicePlanName: string;
    readonly webAppName: string;
    readonly productionSlotName: string;
    readonly applicationInsightsName: string;
    readonly cosmosAccountName: string;
    readonly cosmosDatabaseName: string;
    readonly keyVaultName: string;
    readonly appConfigurationName: string;
    readonly githubAppId: string;
    readonly githubAppKeyVaultUrl: string;
    readonly githubAppKeyName: string;
    readonly githubWebhookSecretKey: string;
    readonly entraAppId: string;
    readonly entraAppIdUrl: string;
    readonly assigneeObjectId?: string;
    readonly cosmosEndpoint: string;
    readonly keyVaultUri: string;
    readonly appConfigurationEndpoint: string;
    readonly webAppEndpoint: string;
    readonly cosmosContainers: readonly CosmosContainerConfig[];
    readonly appConfigurationSettings: readonly AppConfigurationSetting[];
}

type RawVariables = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultVariablesPath = resolve(scriptDirectory, "variables.yaml");

const requiredVariableNames = [
    "APP_CONFIGURATION_NAME",
    "APP_SERVICE_PLAN_NAME",
    "APPLICATION_INSIGHTS_NAME",
    "COSMOS_ACCOUNT_NAME",
    "COSMOS_DB_NAME",
    "KEYVAULT_NAME",
    "RG_LOCATION",
    "RG_NAME",
    "SUBSCRIPTION_ID",
    "TENANT_ID",
    "WEBAPP_NAME",
    "ENTRA_APP_ID",
    "ENTRA_APP_ID_URL",
] as const;

const suffixedVariableNames = new Set<string>([
    "APP_CONFIGURATION_NAME",
    "APP_SERVICE_PLAN_NAME",
    "APPLICATION_INSIGHTS_NAME",
    "COSMOS_ACCOUNT_NAME",
    "KEYVAULT_NAME",
    "RG_NAME",
    "WEBAPP_NAME",
]);

const cosmosContainers: readonly CosmosContainerConfig[] = [
    { name: "adoOperations", partitionKeyPath: "/operationId" },
    { name: "approvalRecords", partitionKeyPath: "/packageVersionKey" },
    { name: "services", partitionKeyPath: "/id" },
    { name: "packages", partitionKeyPath: "/language" },
    { name: "packageVersions", partitionKeyPath: "/packageId" },
    { name: "reviewPullRequests", partitionKeyPath: "/githubRepositoryId" },
    { name: "webhookEvents", partitionKeyPath: "/githubRepositoryId" },
    { name: "repositoryRegistrations", partitionKeyPath: "/githubRepositoryId" },
];

const retentionSettings: readonly AppConfigurationSetting[] = [
    { key: "retention:approvalRecords:days", value: "180" },
    { key: "retention:services:days", value: "180" },
    { key: "retention:packages:days", value: "180" },
    { key: "retention:packageVersions:days", value: "180" },
    { key: "retention:repositoryRegistrations:days", value: "90" },
    { key: "retention:reviewPullRequests:days", value: "90" },
    { key: "retention:adoOperations:days", value: "30" },
    { key: "retention:webhookEvents:days", value: "30" },
];

export async function loadVariables(path = process.env.VARIABLES_PATH ?? defaultVariablesPath): Promise<Variables> {
    const environmentName = getEnvironmentName();
    const rawVariables = await loadRawVariables(path);
    const variables = applyEnvironmentOverrides(rawVariables);
    const missing = requiredVariableNames.filter((name) => !getRequiredValue(variables, name, false));

    if (missing.length > 0) {
        throw new Error(`Missing required variables: ${missing.join(", ")}`);
    }

    const appConfigurationName = getRequiredValue(variables, "APP_CONFIGURATION_NAME", true, environmentName);
    const appServicePlanName = getRequiredValue(variables, "APP_SERVICE_PLAN_NAME", true, environmentName);
    const applicationInsightsName = getRequiredValue(variables, "APPLICATION_INSIGHTS_NAME", true, environmentName);
    const cosmosAccountName = getRequiredValue(variables, "COSMOS_ACCOUNT_NAME", true, environmentName).toLowerCase();
    const keyVaultName = getRequiredValue(variables, "KEYVAULT_NAME", true, environmentName);
    const resourceGroupName = getRequiredValue(variables, "RG_NAME", true, environmentName);
    const webAppName = getRequiredValue(variables, "WEBAPP_NAME", true, environmentName);
    const cosmosDatabaseName = getRequiredValue(variables, "COSMOS_DB_NAME", true);
    const location = getRequiredValue(variables, "RG_LOCATION", true);
    const subscriptionId = getRequiredValue(variables, "SUBSCRIPTION_ID", true);
    const tenantId = getRequiredValue(variables, "TENANT_ID", true);
    const githubAppId = getOptionalValue(variables, "GITHUB_APP_ID");
    const githubAppKeyVaultUrl = getOptionalValue(variables, "GITHUB_APP_KEYVAULT_URL");
    const githubAppKeyName = getOptionalValue(variables, "GITHUB_APP_KEY_NAME");
    const githubWebhookSecretKey = getOptionalValue(variables, "GITHUB_WEBHOOK_SECRET_KEY");
    const entraAppId = getOptionalValue(variables, "ENTRA_APP_ID");
    const entraAppIdUrl = getOptionalValue(variables, "ENTRA_APP_ID_URL");
    const assigneeObjectId = getOptionalValue(process.env, "ASSIGNEE_OBJECT_ID") || undefined;
    const cosmosEndpoint = `https://${cosmosAccountName}.documents.azure.com:443/`;
    const keyVaultUri = `https://${keyVaultName}.vault.azure.net/`;
    const appConfigurationEndpoint = `https://${appConfigurationName}.azconfig.io`;
    const webAppEndpoint = `https://${webAppName}.azurewebsites.net/`;

    const appConfigurationSettings: readonly AppConfigurationSetting[] = [
        { key: "environment_name", value: environmentName },
        { key: "app_configuration_endpoint", value: appConfigurationEndpoint },
        { key: "app_configuration_name", value: appConfigurationName },
        { key: "application_insights_name", value: applicationInsightsName },
        { key: "cosmos_account_name", value: cosmosAccountName },
        { key: "cosmos_db_name", value: cosmosDatabaseName },
        { key: "cosmos_endpoint", value: cosmosEndpoint },
        { key: "cosmos_containers", value: JSON.stringify(cosmosContainers.map((container) => container.name)) },
        { key: "keyvault_uri", value: keyVaultUri },
        { key: "keyvault_name", value: keyVaultName },
        { key: "github_app_id", value: githubAppId },
        { key: "github_app_keyvault_url", value: githubAppKeyVaultUrl },
        { key: "github_app_key_name", value: githubAppKeyName },
        { key: "github_webhook_secret_key", value: githubWebhookSecretKey },
        ...retentionSettings,
    ];

    return {
        environmentName,
        location,
        resourceGroupName,
        subscriptionId,
        tenantId,
        appServicePlanName,
        webAppName,
        productionSlotName: "staging",
        applicationInsightsName,
        cosmosAccountName,
        cosmosDatabaseName,
        keyVaultName,
        appConfigurationName,
        githubAppId,
        githubAppKeyVaultUrl,
        githubAppKeyName,
        githubWebhookSecretKey,
        entraAppId,
        entraAppIdUrl,
        assigneeObjectId,
        cosmosEndpoint,
        keyVaultUri,
        appConfigurationEndpoint,
        webAppEndpoint,
        cosmosContainers,
        appConfigurationSettings,
    };
}

async function loadRawVariables(path: string): Promise<RawVariables> {
    const fileContents = await readFile(path, "utf8");
    const data = load(fileContents);

    if (!isRecord(data)) {
        throw new Error(`Variables file must contain a YAML mapping: ${path}`);
    }

    return data;
}

function applyEnvironmentOverrides(rawVariables: RawVariables): RawVariables {
    const variables: RawVariables = { ...rawVariables };

    for (const key of Object.keys(rawVariables)) {
        if (process.env[key] !== undefined) {
            variables[key] = process.env[key];
        }
    }

    return variables;
}

function getEnvironmentName(): EnvironmentName {
    const value = process.env.ENVIRONMENT_NAME;

    if (value === "production" || value === "backup" || value === "staging") {
        return value;
    }

    throw new Error("ENVIRONMENT_NAME must be set to 'production', 'backup', or 'staging'.");
}

function getRequiredValue(
    variables: RawVariables,
    key: string,
    applySuffix: boolean,
    environmentName?: EnvironmentName,
): string {
    const value = getOptionalValue(variables, key);

    if (!value) {
        return "";
    }

    if (applySuffix && environmentName && suffixedVariableNames.has(key) && environmentName !== "production") {
        return `${value}-${environmentName}`;
    }

    return value;
}

function getOptionalValue(variables: RawVariables | NodeJS.ProcessEnv, key: string): string {
    const value = variables[key];

    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim();
}

function isRecord(value: unknown): value is RawVariables {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}