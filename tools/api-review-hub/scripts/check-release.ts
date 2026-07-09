import type { ReleaseGateDecision } from "../src/models/models.js";
import { getAuthorization } from "./auth.js";

const endpoint = "https://api-review-hub-staging.azurewebsites.net";
const releaseGateRequest = {
    language: "python",
    packageName: "azure-keyvault-keys",
    version: "4.12.0b3",
    //apiHash: "aef97d024f2a340bd992eff0001471606f8270c8d35a69635de9fb50152b9e01",
    //apiHash: "cf0288fa35a9a33129dc573defeb1c42c085dc3f57e0dc1962b48553a8f9983e",
};

async function main(): Promise<void> {
    const url = new URL("/api/releases/check-gate", endpoint);
    for (const [key, value] of Object.entries(releaseGateRequest)) {
        url.searchParams.set(key, value);
    }

    console.log(`Checking release gate at ${endpoint}`);
    console.log(JSON.stringify(releaseGateRequest, null, 2));

    const authorization = await getAuthorization(endpoint);
    const decision = await getJson<ReleaseGateDecision>(url.toString(), authorization);

    console.log("Release gate decision:");
    console.log(JSON.stringify(decision, null, 2));

    process.exitCode = decision.allowed ? 0 : 1;
}

async function getJson<T>(url: string, authorization: string | undefined): Promise<T> {
    const response = await fetch(url, {
        headers: getHeaders(authorization),
    });

    return readResponse<T>(response);
}

function getHeaders(authorization: string | undefined): Record<string, string> {
    return authorization ? { authorization } : {};
}

async function readResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;

    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}: ${JSON.stringify(body)}`);
    }

    return body as T;
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to check release gate: ${message}`);
    process.exitCode = 1;
});