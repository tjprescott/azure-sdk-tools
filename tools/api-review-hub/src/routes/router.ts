import type { IncomingMessage, ServerResponse } from "node:http";

import { requireAzureIdentity, type AuthResult } from "./auth.js";
import { handleGitHubWebhookEvent } from "./github.js";
import { handleAcceptOperationUpdate, handleGetOperationStatus, handleRequestReviewPullRequestCreation } from "./review-prs.js";
import { handleEvaluateReleaseGate, handleMarkPackageVersionReleased } from "./releases.js";
import { sendError } from "./http.js";

type RouteHandler = (request: IncomingMessage, response: ServerResponse, url: URL, pathMatch: RegExpMatchArray, authResult?: AuthResult) => Promise<void>;

interface Route {
    readonly method: string;
    readonly pattern: RegExp;
    readonly handler: RouteHandler;
    readonly auth: "githubWebhook" | "azureIdentity";
}

const requiredRoutes: readonly Route[] = [
    { method: "POST", pattern: /^\/api\/github\/webhook-events$/, handler: handleGitHubWebhookEvent, auth: "githubWebhook" },
    { method: "POST", pattern: /^\/api\/review-prs$/, handler: handleRequestReviewPullRequestCreation, auth: "azureIdentity" },
    {
        method: "GET",
        pattern: /^\/api\/operations\/([^/]+)$/,
        handler: handleGetOperationStatus,
        auth: "azureIdentity",
    },
    {
        method: "POST",
        pattern: /^\/api\/operations\/([^/]+)$/,
        handler: handleAcceptOperationUpdate,
        auth: "azureIdentity",
    },
    { method: "GET", pattern: /^\/api\/releases\/check-gate$/, handler: handleEvaluateReleaseGate, auth: "azureIdentity" },
    { method: "POST", pattern: /^\/api\/releases\/mark-released$/, handler: handleMarkPackageVersionReleased, auth: "azureIdentity" },
];

export interface Router {
    handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export function createRouter(): Router {
    return {
        async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
            const method = request.method ?? "GET";
            const url = new URL(request.url ?? "/", "http://localhost");

            for (const route of requiredRoutes) {
                const pathMatch = url.pathname.match(route.pattern);

                if (pathMatch && route.method === method) {
                    let authResult: AuthResult | undefined;
                    if (route.auth === "azureIdentity") {
                        authResult = await requireAzureIdentity(request);
                        if (!authResult.authenticated) {
                            console.error(JSON.stringify({
                                endpoint: `${method} ${url.pathname}`,
                                authentication: "rejected",
                                statusCode: authResult.statusCode ?? 401,
                                code: authResult.code ?? "unauthorized",
                                target: authResult.target,
                            }));
                            sendError(
                                response,
                                authResult.statusCode ?? 401,
                                authResult.code ?? "unauthorized",
                                authResult.message ?? "The request is not authorized.",
                                authResult.target,
                            );
                            return;
                        }
                    }

                    await route.handler(request, response, url, pathMatch, authResult);
                    return;
                }
            }

            if (requiredRoutes.some((route) => route.pattern.test(url.pathname))) {
                sendError(response, 405, "methodNotAllowed", "The requested endpoint does not support this HTTP method.");
                return;
            }

            sendError(response, 404, "notFound", "The requested endpoint was not found.");
        },
    };
}