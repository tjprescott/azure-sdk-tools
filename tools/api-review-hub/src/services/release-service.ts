import type { ApprovalRecord, MarkPackageVersionReleasedRequest, ReleaseGateDecision } from "../models/models.js";
import { findLatestApprovalRecordForApiHash } from "./approval-record-store.js";
import { markPackageVersionReleased as markStoredPackageVersionReleased } from "./package-store.js";

interface ReleaseGateRequest {
    readonly language: string;
    readonly packageName: string;
    readonly version: string;
    readonly apiHash: string;
}

export async function evaluateReleaseGate(request: ReleaseGateRequest): Promise<ReleaseGateDecision> {
    if (!request.apiHash) {
        return {
            allowed: false,
            reason: "missingApiHash",
            approval: createReleaseGateApproval(request, "pending"),
        };
    }

    const approval = await findLatestApprovalRecordForApiHash(request.language, request.packageName, request.version, request.apiHash);
    if (!approval) {
        return {
            allowed: false,
            reason: "missingApproval",
            approval: createReleaseGateApproval(request, "pending"),
        };
    }

    if (approval.status === "approved") {
        return {
            allowed: true,
            reason: "approved",
            approval,
        };
    }

    return {
        allowed: false,
        reason: approval.status === "rejected" ? "rejected" : "missingApproval",
        approval,
    };
}

export async function markPackageVersionReleased(request: MarkPackageVersionReleasedRequest): Promise<boolean> {
    const packageVersion = await markStoredPackageVersionReleased(request.language, request.packageName, request.version, request.releasedOn);
    return packageVersion !== undefined;
}

function createReleaseGateApproval(request: ReleaseGateRequest, status: ApprovalRecord["status"]): ApprovalRecord {
    return {
        packageName: request.packageName,
        version: request.version,
        apiHash: request.apiHash,
        status,
        lastUpdatedBy: "api-review-hub",
        lastUpdatedOn: new Date().toISOString(),
    };
}