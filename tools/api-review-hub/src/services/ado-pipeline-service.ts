import { DefaultAzureCredential } from "@azure/identity";

const azureDevOpsScope = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const azureDevOpsOrganizationUrl = "https://dev.azure.com/azure-sdk";
const defaultAzureDevOpsProject = "internal";
const credential = new DefaultAzureCredential();

export type AdoPipelineTemplateParameters = Record<string, unknown>;

export interface QueueAdoPipelineRequest {
    readonly project?: string;
    readonly pipelineId: string;
    readonly templateParameters: AdoPipelineTemplateParameters;
}

export interface QueueAdoPipelineResult {
    readonly buildId: string;
    readonly runUrl?: string;
}

export interface QueueApiReviewPipelineRequest {
    readonly operationId: string;
    readonly pipelineProject?: string;
    readonly pipelineId: string;
    readonly requestMode: "create" | "update";
    readonly language: string;
    readonly packageName: string;
    readonly baseRef?: string;
    readonly targetRef: string;
}

export type QueueApiReviewPipelineResult = QueueAdoPipelineResult;

const maxLoggedResponseBodyLength = 4000;

interface AzureDevOpsRunResponse {
    readonly id?: number;
    readonly url?: string;
    readonly _links?: {
        readonly web?: {
            readonly href?: string;
        };
    };
}

export class AdoPipelineConfigurationError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "AdoPipelineConfigurationError";
    }
}

export class AdoPipelineQueueError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "AdoPipelineQueueError";
    }
}

export async function queueAdoPipeline(request: QueueAdoPipelineRequest): Promise<QueueAdoPipelineResult> {
    console.log(JSON.stringify({
        event: "adoPipelineTokenRequested",
        scope: azureDevOpsScope,
        pipelineProject: request.project ?? defaultAzureDevOpsProject,
        pipelineId: request.pipelineId,
    }));

    let token;
    try {
        token = await credential.getToken(azureDevOpsScope);
    } catch (error) {
        console.error(JSON.stringify({
            event: "adoPipelineTokenFailed",
            scope: azureDevOpsScope,
            pipelineProject: request.project ?? defaultAzureDevOpsProject,
            pipelineId: request.pipelineId,
            error: getErrorMessage(error),
        }));
        throw new AdoPipelineQueueError(`Failed to acquire an Azure DevOps access token: ${getErrorMessage(error)}`);
    }

    if (!token) {
        console.error(JSON.stringify({
            event: "adoPipelineTokenMissing",
            scope: azureDevOpsScope,
            pipelineProject: request.project ?? defaultAzureDevOpsProject,
            pipelineId: request.pipelineId,
        }));
        throw new AdoPipelineQueueError("Failed to acquire an Azure DevOps access token.");
    }

    console.log(JSON.stringify({
        event: "adoPipelineTokenAcquired",
        scope: azureDevOpsScope,
        expiresOnTimestamp: token.expiresOnTimestamp,
        pipelineProject: request.project ?? defaultAzureDevOpsProject,
        pipelineId: request.pipelineId,
    }));

    const organizationUrl = azureDevOpsOrganizationUrl.replace(/\/+$/, "");
    const project = encodeURIComponent(request.project ?? defaultAzureDevOpsProject);
    const pipelineId = encodeURIComponent(request.pipelineId);
    const url = `${organizationUrl}/${project}/_apis/pipelines/${pipelineId}/runs?api-version=7.1`;
    const requestBody = {
        templateParameters: request.templateParameters,
    };

    console.log(JSON.stringify({
        event: "adoPipelineQueueRequest",
        organizationUrl,
        pipelineProject: request.project ?? defaultAzureDevOpsProject,
        pipelineId: request.pipelineId,
        url,
        body: requestBody,
    }));

    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "authorization": `Bearer ${token.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
        });
    } catch (error) {
        console.error(JSON.stringify({
            event: "adoPipelineQueueRequestFailed",
            pipelineProject: request.project ?? defaultAzureDevOpsProject,
            pipelineId: request.pipelineId,
            url,
            error: getErrorMessage(error),
        }));
        throw new AdoPipelineQueueError(`Failed to send Azure DevOps queue request for pipeline ${request.pipelineId} at ${url}: ${getErrorMessage(error)}`);
    }

    console.log(JSON.stringify({
        event: "adoPipelineQueueResponse",
        pipelineProject: request.project ?? defaultAzureDevOpsProject,
        pipelineId: request.pipelineId,
        url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
    }));

    if (!response.ok) {
        const responseBody = await readResponseBodyForLogging(response);
        console.error(JSON.stringify({
            event: "adoPipelineQueueFailed",
            pipelineProject: request.project ?? defaultAzureDevOpsProject,
            pipelineId: request.pipelineId,
            url,
            status: response.status,
            statusText: response.statusText,
            responseBody,
        }));
        throw new AdoPipelineQueueError(
            `Azure DevOps returned ${response.status} ${response.statusText} while queueing pipeline ${request.pipelineId} at ${url}. Response body: ${responseBody}`,
        );
    }

    const run = await response.json() as AzureDevOpsRunResponse;
    if (typeof run.id !== "number") {
        throw new AdoPipelineQueueError(`Azure DevOps did not return a run id for queued pipeline ${request.pipelineId}.`);
    }

    console.log(JSON.stringify({
        event: "adoPipelineQueueSucceeded",
        pipelineProject: request.project ?? defaultAzureDevOpsProject,
        pipelineId: request.pipelineId,
        buildId: String(run.id),
        runUrl: run._links?.web?.href ?? run.url,
    }));

    return {
        buildId: String(run.id),
        runUrl: run._links?.web?.href ?? run.url,
    };
}

export async function queueApiReviewPipeline(request: QueueApiReviewPipelineRequest): Promise<QueueApiReviewPipelineResult> {
    const apiReviewHubEndpoint = getRequiredEnvironmentVariable("WEBAPP_ENDPOINT");
    const completionCallbackUrl = buildCompletionCallbackUrl(apiReviewHubEndpoint, request.operationId);

    console.log(JSON.stringify({
        event: "apiReviewPipelineQueuePrepared",
        operationId: request.operationId,
        pipelineProject: request.pipelineProject ?? defaultAzureDevOpsProject,
        pipelineId: request.pipelineId,
        requestMode: request.requestMode,
        language: request.language,
        packageName: request.packageName,
        baseRef: request.baseRef ?? "",
        targetRef: request.targetRef,
        apiReviewHubEndpoint,
        completionCallbackUrl,
    }));

    return queueAdoPipeline({
        project: request.pipelineProject,
        pipelineId: request.pipelineId,
        templateParameters: {
            requestMode: request.requestMode,
            language: request.language,
            operationId: request.operationId,
            packageName: request.packageName,
            baseRef: request.baseRef ?? "",
            targetRef: request.targetRef,
            completionCallbackUrl,
        },
    });
}

function buildCompletionCallbackUrl(apiReviewHubEndpoint: string, operationId: string): string {
    const endpoint = apiReviewHubEndpoint.replace(/\/+$/, "");
    return `${endpoint}/api/operations/${encodeURIComponent(operationId)}`;
}

function getRequiredEnvironmentVariable(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new AdoPipelineConfigurationError(`Missing required environment variable: ${name}`);
    }

    return value;
}

async function readResponseBodyForLogging(response: Response): Promise<string> {
    const body = await response.text();
    if (!body) {
        return "<empty>";
    }

    if (body.length <= maxLoggedResponseBodyLength) {
        return body;
    }

    return `${body.slice(0, maxLoggedResponseBodyLength)}... <truncated>`;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
