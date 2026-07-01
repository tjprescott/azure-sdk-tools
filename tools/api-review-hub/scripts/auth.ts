import { DefaultAzureCredential } from "@azure/identity";

let tokenScope: string | undefined;

export async function getAuthorization(endpoint: string): Promise<string | undefined> {
    const tokenScope = getTokenScope(endpoint);
    let token;
    try {
        token = await new DefaultAzureCredential().getToken(tokenScope);
    } catch (error) {
        console.warn(
            `Unable to acquire an Entra token for ${tokenScope}. Sending the request without Authorization so the service can reject it. ${getErrorMessage(error)}`,
        );
        return undefined;
    }

    if (!token) {
        console.warn(`Unable to acquire an Entra token for ${tokenScope}. Sending the request without Authorization so the service can reject it.`);
        return undefined;
    }

    return `Bearer ${token.token}`;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
}

function getTokenScope(endpoint: string): string {
    tokenScope ??= `${getAppIdUri(endpoint)}/.default`;
    return tokenScope;
}

function getAppIdUri(endpoint: string): string {
    const host = new URL(endpoint).hostname;
    const siteName = host.split(".", 1)[0] ?? "";
    const prefix = "api-review-hub";

    if (!siteName.startsWith(prefix)) {
        throw new Error(`Unable to derive API Review Hub Entra App ID URI from endpoint host ${host}.`);
    }

    const environmentSuffix = siteName.slice(prefix.length);
    return `api://apireviewhub${environmentSuffix}`;
}
