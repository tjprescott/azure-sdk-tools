import type { OperationStatus, OperationUpdate } from "../src/models/models.js";
import { getAuthorization } from "./auth.js";

const endpoint = ("https://api-review-hub-staging.azurewebsites.net").replace(/\/+$/, "");
const operationId = "1234567890";

const callback: OperationUpdate = {
    operationId,
    mode: "create",
    language: "python",
    buildId: "6508165",
    project: "playground",
    result: "Succeeded",
    artifacts: {
        base: "apireview-base",
        target: "apireview-target",
        result: "apireview-result",
    },
};

async function main(): Promise<void> {
    console.log(`Posting API review callback to ${endpoint}`);
    console.log(JSON.stringify(callback, null, 2));

    const authorization = await getAuthorization(endpoint);
    const accepted = await postJson<OperationStatus>(`${endpoint}/api/operations/${encodeURIComponent(operationId)}`, callback, authorization);
    console.log("Callback accepted:");
    console.log(JSON.stringify(accepted, null, 2));
}

async function postJson<T>(url: string, body: unknown, authorization: string | undefined): Promise<T> {
    const response = await fetch(url, {
        method: "POST",
        headers: getHeaders(authorization, { "content-type": "application/json" }),
        body: JSON.stringify(body),
    });

    return readResponse<T>(response);
}

function getHeaders(authorization: string | undefined, headers: Record<string, string> = {}): Record<string, string> {
    if (authorization) {
        headers.authorization = authorization;
    }

    return headers;
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
    console.error(`Failed to post API review callback: ${message}`);
    process.exitCode = 1;
});