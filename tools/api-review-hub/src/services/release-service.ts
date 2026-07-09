import type { MarkPackageVersionReleasedRequest, ReleaseGateApprovalRecord, ReleaseGateDecision } from "../models/models.js";
import type { ApprovalRecord } from "./approval-record-store.js";
import { findApprovalRecordsForPackageVersion } from "./approval-record-store.js";
import { markPackageVersionReleased as markStoredPackageVersionReleased } from "./package-store.js";

interface ReleaseGateRequest {
    readonly language: string;
    readonly packageName: string;
    readonly version: string;
    readonly apiHash: string;
}

export async function evaluateReleaseGate(request: ReleaseGateRequest): Promise<ReleaseGateDecision> {
    const approvalRecords = await findApprovalRecordsForPackageVersion(request.language, request.packageName, request.version);
    const approvals = approvalRecords.map(toReleaseGateApprovalRecord);

    if (!request.apiHash) {
        return {
            allowed: false,
            reason: "missingApiHash",
            details: "Release gate evaluation requires an API hash.",
            approvals,
        };
    }

    const matchingApprovals = approvalRecords.filter((approval) => approval.apiHash === request.apiHash);
    if (matchingApprovals.some((approval) => approval.status === "rejected")) {
        return {
            allowed: false,
            reason: "rejected",
            details: "At least one architect has requested changes for this API.",
            approvals,
        };
    }

    if (matchingApprovals.some((approval) => approval.status === "approved")) {
        return {
            allowed: true,
            reason: "approved",
            approvals,
        };
    }

    return {
        allowed: false,
        reason: "missingApproval",
        details: "No current architect approval was found for this API hash.",
        approvals,
    };
}

export async function markPackageVersionReleased(request: MarkPackageVersionReleasedRequest): Promise<boolean> {
    const packageVersion = await markStoredPackageVersionReleased(request.language, request.packageName, request.version, request.releasedOn);
    return packageVersion !== undefined;
}

function toReleaseGateApprovalRecord(record: ApprovalRecord): ReleaseGateApprovalRecord {
    return {
        apiHash: record.apiHash,
        ...(record.commitSha ? { commitSha: record.commitSha } : {}),
        status: record.status,
        pullRequestUrl: record.pullRequestUrl,
        lastUpdatedBy: record.lastUpdatedBy,
        lastUpdatedOn: record.lastUpdatedOn,
    };
}