import type { IncomingMessage } from "node:http";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { getRequiredSetting } from "../config/settings.js";
import { getRequiredHeader } from "./http.js";

let authSettingsPromise: Promise<AuthSettings> | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

interface AuthSettings {
    readonly tenantId: string;
    readonly audiences: string[];
}

export interface AuthResult {
    readonly authenticated: boolean;
    readonly statusCode?: number;
    readonly code?: string;
    readonly message?: string;
    readonly target?: string;
    readonly claims?: JWTPayload;
}

export async function requireAzureIdentity(request: IncomingMessage): Promise<AuthResult> {
    const authorization = getRequiredHeader(request, "Authorization");
    if (!authorization) {
        return {
            authenticated: false,
            statusCode: 401,
            code: "missingAuthorization",
            message: "The Authorization header is required.",
            target: "Authorization",
        };
    }

    const token = getBearerToken(authorization);
    if (!token) {
        return {
            authenticated: false,
            statusCode: 401,
            code: "invalidAuthorization",
            message: "The Authorization header must contain a bearer token.",
            target: "Authorization",
        };
    }

    let settings: AuthSettings;
    try {
        settings = await getAuthSettings();
    } catch (error) {
        return {
            authenticated: false,
            statusCode: 500,
            code: "authenticationConfigurationMissing",
            message: "The service authentication configuration is incomplete.",
        };
    }

    const issuer = [
        `https://login.microsoftonline.com/${settings.tenantId}/v2.0`,
        `https://login.microsoftonline.com/${settings.tenantId}/`,
        `https://sts.windows.net/${settings.tenantId}/`,
    ];
    const audience = settings.audiences;

    try {
        const verified = await jwtVerify(token, getJwks(settings.tenantId), { audience, issuer });
        if (!hasAzureObjectId(verified.payload)) {
            return {
                authenticated: false,
                statusCode: 403,
                code: "invalidAzureIdentity",
                message: "The bearer token does not identify an Azure identity.",
            };
        }

        return { authenticated: true, claims: verified.payload };
    } catch (error) {
        return {
            authenticated: false,
            statusCode: 401,
            code: "invalidAuthorization",
            message: "The bearer token is invalid.",
            target: "Authorization",
        };
    }
}

function getBearerToken(authorization: string): string | undefined {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match?.[1];
}

function hasAzureObjectId(claims: JWTPayload): boolean {
    return hasStringClaim(claims, "oid") || hasStringClaim(claims, "http://schemas.microsoft.com/identity/claims/objectidentifier");
}

function hasStringClaim(claims: JWTPayload, name: string): boolean {
    const value = claims[name];
    return typeof value === "string" && value.trim().length > 0;
}

async function getAuthSettings(): Promise<AuthSettings> {
    if (!authSettingsPromise) {
        authSettingsPromise = getRequiredSetting("tenant_id").then((tenantId) => {
            const appId = getRequiredEnvironmentVariable("ENTRA_APP_ID");
            const appIdUrl = getRequiredEnvironmentVariable("ENTRA_APP_ID_URL");
            const audiences = [appId, appIdUrl];
            return {
                tenantId,
                audiences,
            };
        });
    }

    return authSettingsPromise;
}

function getRequiredEnvironmentVariable(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

function getJwks(tenantId: string): ReturnType<typeof createRemoteJWKSet> {
    if (!jwks) {
        const jwksUrl = new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
        jwks = createRemoteJWKSet(jwksUrl);
    }

    return jwks;
}