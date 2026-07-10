import { AppConfigurationClient } from "@azure/app-configuration";
import { DefaultAzureCredential } from "@azure/identity";

const credential = new DefaultAzureCredential();
let appConfigurationClient: AppConfigurationClient | undefined;

export async function getRequiredSetting(key: string): Promise<string> {
    const value = await getSetting(key);

    if (!value) {
        throw new Error(`Missing required setting: ${key}`);
    }

    return value;
}

async function getSetting(key: string): Promise<string | undefined> {
    const environmentVariableName = toEnvironmentVariableName(key);
    const environmentValue = process.env[environmentVariableName];
    if (environmentValue) {
        return environmentValue;
    }

    const endpoint = process.env.AZURE_APP_CONFIG_ENDPOINT;
    if (!endpoint) {
        return undefined;
    }

    appConfigurationClient ??= new AppConfigurationClient(endpoint, credential);
    try {
        const setting = await appConfigurationClient.getConfigurationSetting({ key });
        return setting.value;
    } catch (error) {
        if (isAppConfigurationSettingNotFound(error)) {
            return undefined;
        }

        throw error;
    }
}

function toEnvironmentVariableName(key: string): string {
    return key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function isAppConfigurationSettingNotFound(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "statusCode" in error
        && (error as { statusCode?: unknown }).statusCode === 404;
}