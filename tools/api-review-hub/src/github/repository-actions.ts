import { load } from "js-yaml";

import { getRepositoryInstallationToken, gitHubFetch, gitHubRequest } from "./github-app.js";

const architectsFilePath = ".github/ARCHITECTS";
const architectsFileRef = "main";

export interface ApiReviewBranchFileSet {
    readonly packageRelativePath: string;
    readonly apiMd: string;
    readonly apiMetadataYaml: string;
}

export interface PublishApiReviewPullRequestRequest {
    readonly owner: string;
    readonly repo: string;
    readonly targetBranch: string;
    readonly baseBranch: string;
    readonly reviewBranch: string;
    readonly packageName: string;
    readonly baseRef: string;
    readonly targetRef: string;
    readonly baseVersion: string;
    readonly targetVersion: string;
    readonly baseFiles: ApiReviewBranchFileSet;
    readonly targetFiles: ApiReviewBranchFileSet;
}

export interface PublishedApiReviewPullRequest {
    readonly repository: {
        readonly id: number;
        readonly owner: string;
        readonly repo: string;
    };
    readonly number: number;
    readonly url: string;
    readonly status: "draft" | "open";
    readonly baseBranch: string;
    readonly reviewBranch: string;
}

export interface ArchitectReviewers {
    readonly users: string[];
    readonly teams: string[];
}

export interface IsArchitectReviewerForPackageOptions {
    readonly owner: string;
    readonly repo: string;
    readonly packageRelativePath: string;
    readonly reviewer: string;
}

export interface GetApiHashForPackageAtCommitOptions {
    readonly owner: string;
    readonly repo: string;
    readonly packageRelativePath: string;
    readonly commitSha: string;
}

export interface ReviewPullRequestLabelOptions {
    readonly owner: string;
    readonly repo: string;
    readonly pullRequestNumber: number;
}

export interface ReviewPullRequestOutOfDateOptions extends ReviewPullRequestLabelOptions {
    readonly operationId: string;
    readonly pipelineUrl?: string;
}

export interface ClearReviewPullRequestOutOfDateOptions extends ReviewPullRequestLabelOptions {
    readonly operationId?: string;
}

export interface GitBranchDeleteOptions {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
}

export interface GitReferenceExistsOptions {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
    readonly kinds: readonly ("heads" | "tags")[];
}

export interface PublishUpdatedApiReviewArtifactsRequest {
    readonly owner: string;
    readonly repo: string;
    readonly reviewBranch: string;
    readonly packageName: string;
    readonly files: ApiReviewBranchFileSet;
}

export interface PublishedUpdatedApiReviewArtifacts {
    readonly changed: boolean;
    readonly commitSha?: string;
}

interface GitHubRefResponse {
    readonly object: {
        readonly sha: string;
    };
}

interface GitHubCommitResponse {
    readonly sha: string;
    readonly tree: {
        readonly sha: string;
    };
}

interface GitHubBlobResponse {
    readonly sha: string;
}

interface GitHubTreeResponse {
    readonly sha: string;
}

interface GitHubPullRequestResponse {
    readonly number: number;
    readonly title: string;
    readonly html_url: string;
    readonly draft: boolean;
    readonly base: {
        readonly repo: {
            readonly id: number;
        };
    };
}

interface GitHubPullRequestReference {
    readonly number: number;
    readonly title: string;
    readonly htmlUrl: string;
}

interface GitHubIssueCommentResponse {
    readonly id: number;
    readonly body?: string;
    readonly user?: {
        readonly login?: string;
    };
}

interface GitHubContentResponse {
    readonly content?: string;
    readonly encoding?: string;
}

interface ArchitectEntry {
    readonly pattern: string;
    readonly owners: string[];
}

const reviewOutOfDateCommentMarker = "<!-- api-review-hub:review-out-of-date -->";
const reviewOutOfDateCommentText = "A change has been pushed to the working branch and is being processed.";
const reviewInSyncCommentText = "The working branch and review PR are currently in sync.";

export async function publishApiReviewPullRequest(request: PublishApiReviewPullRequestRequest): Promise<PublishedApiReviewPullRequest> {
    const token = await getRepositoryInstallationToken(request.owner, request.repo);
    const repositoryUrl = `https://api.github.com/repos/${request.owner}/${request.repo}`;
    const targetRef = await getRef(repositoryUrl, token, toHeadsRef(request.targetBranch));
    const targetCommit = await gitHubRequest<GitHubCommitResponse>(`${repositoryUrl}/git/commits/${targetRef.object.sha}`, token, "Bearer");

    const baseCommit = await createArtifactCommit({
        repositoryUrl,
        token,
        parentSha: targetRef.object.sha,
        baseTreeSha: targetCommit.tree.sha,
        message: `API review baseline for ${request.packageName}`,
        files: request.baseFiles,
    });
    await upsertRef(repositoryUrl, token, request.baseBranch, baseCommit.sha);

    const reviewCommit = await createArtifactCommit({
        repositoryUrl,
        token,
        parentSha: baseCommit.sha,
        baseTreeSha: baseCommit.tree.sha,
        message: `API review target for ${request.packageName}`,
        files: request.targetFiles,
    });
    await upsertRef(repositoryUrl, token, request.reviewBranch, reviewCommit.sha);

    const workingPullRequest = await findOpenPullRequestForBranch(repositoryUrl, token, request.owner, request.targetBranch);

    const pullRequest = await getOrCreatePullRequest({
        repositoryUrl,
        token,
        owner: request.owner,
        packageName: request.packageName,
        baseRef: request.baseRef,
        targetRef: request.targetRef,
        baseVersion: request.baseVersion,
        targetVersion: request.targetVersion,
        baseBranch: request.baseBranch,
        reviewBranch: request.reviewBranch,
        workingPullRequest,
    });

    await applyReviewWorkflowMetadata({
        repositoryUrl,
        token,
        pullRequestNumber: pullRequest.number,
        targetBranch: request.targetBranch,
        packageRelativePath: request.targetFiles.packageRelativePath,
    });

    return {
        repository: {
            id: pullRequest.base.repo.id,
            owner: request.owner,
            repo: request.repo,
        },
        number: pullRequest.number,
        url: pullRequest.html_url,
        status: pullRequest.draft ? "draft" : "open",
        baseBranch: request.baseBranch,
        reviewBranch: request.reviewBranch,
    };
}

async function applyReviewWorkflowMetadata(options: {
    readonly repositoryUrl: string;
    readonly token: string;
    readonly pullRequestNumber: number;
    readonly targetBranch: string;
    readonly packageRelativePath: string;
}): Promise<void> {
    await addReviewNeededLabel(options.repositoryUrl, options.token, options.pullRequestNumber);

    const reviewers = await resolveArchitectReviewers(options.repositoryUrl, options.token, options.packageRelativePath);
    if (reviewers.users.length === 0 && reviewers.teams.length === 0) {
        console.warn(JSON.stringify({
            event: "architectReviewersNotFound",
            pullRequestNumber: options.pullRequestNumber,
            packageRelativePath: options.packageRelativePath,
        }));
        return;
    }

    const reviewersRequested = await requestReviewers(options.repositoryUrl, options.token, options.pullRequestNumber, reviewers);
    if (!reviewersRequested) {
        await addArchitectFallbackComment(options.repositoryUrl, options.token, options.pullRequestNumber, reviewers);
    }
}

export async function resolveArchitectReviewersForPackage(options: {
    readonly owner: string;
    readonly repo: string;
    readonly packageRelativePath: string;
}): Promise<ArchitectReviewers> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    return resolveArchitectReviewers(repositoryUrl, token, options.packageRelativePath);
}

export async function isArchitectReviewerForPackage(options: IsArchitectReviewerForPackageOptions): Promise<boolean> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    const reviewers = await resolveArchitectReviewers(repositoryUrl, token, options.packageRelativePath);
    const reviewer = normalizeArchitectOwner(options.reviewer);

    if (!reviewer) {
        return false;
    }

    if (reviewers.users.some((user) => user.toLowerCase() === reviewer.toLowerCase())) {
        return true;
    }

    for (const team of reviewers.teams) {
        if (await isRepositoryOwnerTeamMember(options.owner, team, reviewer, token)) {
            return true;
        }
    }

    return false;
}

export async function getApiHashForPackageAtCommit(options: GetApiHashForPackageAtCommitOptions): Promise<string> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    const packageRelativePath = normalizePackageRelativePath(options.packageRelativePath);
    const apiMetadataYaml = await readRepositoryFile(repositoryUrl, token, `${packageRelativePath}/api.metadata.yml`, options.commitSha);
    if (!apiMetadataYaml) {
        throw new Error(`API metadata file was not found for '${packageRelativePath}' at commit '${options.commitSha}'.`);
    }

    const apiHash = getApiHashFromMetadata(load(apiMetadataYaml));
    if (!apiHash) {
        throw new Error(`API metadata file for '${packageRelativePath}' at commit '${options.commitSha}' did not include apiHash.`);
    }

    return apiHash;
}

export async function markReviewPullRequestOutOfDate(options: ReviewPullRequestOutOfDateOptions): Promise<void> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    await addLabel(repositoryUrl, token, options.pullRequestNumber, "review-out-of-date", "b60205", "API review artifacts are being regenerated for newer working branch changes.");
    await upsertReviewOutOfDateComment(repositoryUrl, token, options.pullRequestNumber, options.operationId, options.pipelineUrl);
}

export async function clearReviewPullRequestOutOfDate(options: ClearReviewPullRequestOutOfDateOptions): Promise<void> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    if (options.operationId && await hasDifferentReviewOutOfDateOperation(repositoryUrl, token, options.pullRequestNumber, options.operationId)) {
        return;
    }

    await removeLabel(repositoryUrl, token, options.pullRequestNumber, "review-out-of-date");
    await updateReviewOutOfDateCommentToInSync(repositoryUrl, token, options.pullRequestNumber, options.operationId);
}

export async function deleteGitBranch(options: GitBranchDeleteOptions): Promise<boolean> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    return deleteRef(repositoryUrl, token, toHeadsRef(options.branch));
}

export async function gitReferenceExists(options: GitReferenceExistsOptions): Promise<boolean> {
    const token = await getRepositoryInstallationToken(options.owner, options.repo);
    const repositoryUrl = `https://api.github.com/repos/${options.owner}/${options.repo}`;
    for (const ref of getCandidateRefs(options.ref, options.kinds)) {
        if (await refExists(repositoryUrl, token, ref)) {
            return true;
        }
    }

    return false;
}

export async function publishUpdatedApiReviewArtifacts(request: PublishUpdatedApiReviewArtifactsRequest): Promise<PublishedUpdatedApiReviewArtifacts> {
    const token = await getRepositoryInstallationToken(request.owner, request.repo);
    const repositoryUrl = `https://api.github.com/repos/${request.owner}/${request.repo}`;
    const packageRelativePath = normalizePackageRelativePath(request.files.packageRelativePath);
    const [currentApiMd, currentApiMetadataYaml] = await Promise.all([
        readRepositoryFile(repositoryUrl, token, `${packageRelativePath}/api.md`, request.reviewBranch),
        readRepositoryFile(repositoryUrl, token, `${packageRelativePath}/api.metadata.yml`, request.reviewBranch),
    ]);

    if (currentApiMd === request.files.apiMd && currentApiMetadataYaml === request.files.apiMetadataYaml) {
        return { changed: false };
    }

    const reviewRef = await getRef(repositoryUrl, token, toHeadsRef(request.reviewBranch));
    const reviewCommit = await gitHubRequest<GitHubCommitResponse>(`${repositoryUrl}/git/commits/${reviewRef.object.sha}`, token, "Bearer");
    const updateCommit = await createArtifactCommit({
        repositoryUrl,
        token,
        parentSha: reviewRef.object.sha,
        baseTreeSha: reviewCommit.tree.sha,
        message: `Update API review target for ${request.packageName}`,
        files: request.files,
    });
    await upsertRef(repositoryUrl, token, request.reviewBranch, updateCommit.sha);

    return { changed: true, commitSha: updateCommit.sha };
}

async function isRepositoryOwnerTeamMember(owner: string, team: string, user: string, token: string): Promise<boolean> {
    const response = await gitHubFetch(
        `https://api.github.com/orgs/${encodeURIComponent(owner)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(user)}`,
        token,
        "Bearer",
    );

    if (response.status === 404) {
        return false;
    }

    if (!response.ok) {
        console.warn(JSON.stringify({
            event: "architectTeamMembershipCheckFailed",
            owner,
            team,
            user,
            status: response.status,
            responseBody: await response.text(),
        }));
        return false;
    }

    const membership = await response.json() as { state?: string };
    return membership.state === "active";
}

async function createArtifactCommit(options: {
    readonly repositoryUrl: string;
    readonly token: string;
    readonly parentSha: string;
    readonly baseTreeSha: string;
    readonly message: string;
    readonly files: ApiReviewBranchFileSet;
}): Promise<GitHubCommitResponse> {
    const apiMdBlob = await createBlob(options.repositoryUrl, options.token, options.files.apiMd);
    const apiMetadataBlob = await createBlob(options.repositoryUrl, options.token, options.files.apiMetadataYaml);
    const packageRelativePath = normalizePackageRelativePath(options.files.packageRelativePath);
    const tree = await gitHubRequest<GitHubTreeResponse>(`${options.repositoryUrl}/git/trees`, options.token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            base_tree: options.baseTreeSha,
            tree: [
                {
                    path: `${packageRelativePath}/api.md`,
                    mode: "100644",
                    type: "blob",
                    sha: apiMdBlob.sha,
                },
                {
                    path: `${packageRelativePath}/api.metadata.yml`,
                    mode: "100644",
                    type: "blob",
                    sha: apiMetadataBlob.sha,
                },
            ],
        }),
    });

    return gitHubRequest<GitHubCommitResponse>(`${options.repositoryUrl}/git/commits`, options.token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            message: options.message,
            tree: tree.sha,
            parents: [options.parentSha],
        }),
    });
}

async function createBlob(repositoryUrl: string, token: string, content: string): Promise<GitHubBlobResponse> {
    return gitHubRequest<GitHubBlobResponse>(`${repositoryUrl}/git/blobs`, token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            content,
            encoding: "utf-8",
        }),
    });
}

async function getRef(repositoryUrl: string, token: string, ref: string): Promise<GitHubRefResponse> {
    return gitHubRequest<GitHubRefResponse>(`${repositoryUrl}/git/ref/${encodeGitRefPath(ref)}`, token, "Bearer");
}

async function refExists(repositoryUrl: string, token: string, ref: string): Promise<boolean> {
    const response = await gitHubFetch(`${repositoryUrl}/git/ref/${encodeGitRefPath(ref)}`, token, "Bearer");
    if (response.ok) {
        return true;
    }

    if (response.status === 404) {
        return false;
    }

    throw new Error(`GitHub API request failed with status ${response.status}: ${await response.text()}`);
}

async function upsertRef(repositoryUrl: string, token: string, branch: string, sha: string): Promise<void> {
    const ref = toHeadsRef(branch);
    const existingRef = await gitHubFetch(`${repositoryUrl}/git/ref/${encodeGitRefPath(ref)}`, token, "Bearer");
    if (existingRef.status === 404) {
        await gitHubRequest<GitHubRefResponse>(`${repositoryUrl}/git/refs`, token, "Bearer", {
            method: "POST",
            body: JSON.stringify({
                ref: `refs/${ref}`,
                sha,
            }),
        });
        return;
    }

    if (!existingRef.ok) {
        throw new Error(`GitHub API request failed with status ${existingRef.status}: ${await existingRef.text()}`);
    }

    await gitHubRequest<GitHubRefResponse>(`${repositoryUrl}/git/refs/${encodeGitRefPath(ref)}`, token, "Bearer", {
        method: "PATCH",
        body: JSON.stringify({
            sha,
            force: true,
        }),
    });
}

async function deleteRef(repositoryUrl: string, token: string, ref: string): Promise<boolean> {
    const response = await gitHubFetch(`${repositoryUrl}/git/refs/${encodeGitRefPath(ref)}`, token, "Bearer", {
        method: "DELETE",
    });
    if (response.ok) {
        return true;
    }

    if (response.status === 404) {
        return false;
    }

    throw new Error(`GitHub API request failed with status ${response.status}: ${await response.text()}`);
}

async function getOrCreatePullRequest(options: {
    readonly repositoryUrl: string;
    readonly token: string;
    readonly owner: string;
    readonly packageName: string;
    readonly baseRef: string;
    readonly targetRef: string;
    readonly baseVersion: string;
    readonly targetVersion: string;
    readonly baseBranch: string;
    readonly reviewBranch: string;
    readonly workingPullRequest: GitHubPullRequestReference | undefined;
}): Promise<GitHubPullRequestResponse> {
    const title = `[API Review] ${options.packageName} ${options.targetVersion} (base ${options.baseVersion})`;
    const body = createReviewPullRequestBody(options);
    const searchParameters = new URLSearchParams({
        state: "open",
        base: options.baseBranch,
        head: `${options.owner}:${options.reviewBranch}`,
    });
    const existingPullRequests = await gitHubRequest<GitHubPullRequestResponse[]>(
        `${options.repositoryUrl}/pulls?${searchParameters}`,
        options.token,
        "Bearer",
    );
    if (existingPullRequests.length > 0) {
        const pullRequest = existingPullRequests[0]!;
        return gitHubRequest<GitHubPullRequestResponse>(`${options.repositoryUrl}/pulls/${pullRequest.number}`, options.token, "Bearer", {
            method: "PATCH",
            body: JSON.stringify({
                title,
                body,
            }),
        });
    }

    return gitHubRequest<GitHubPullRequestResponse>(`${options.repositoryUrl}/pulls`, options.token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            title,
            head: options.reviewBranch,
            base: options.baseBranch,
            body,
        }),
    });
}

async function findOpenPullRequestForBranch(
    repositoryUrl: string,
    token: string,
    owner: string,
    branch: string,
): Promise<GitHubPullRequestReference | undefined> {
    const searchParameters = new URLSearchParams({
        state: "open",
        head: `${owner}:${branch}`,
    });
    const pullRequests = await gitHubRequest<GitHubPullRequestResponse[]>(`${repositoryUrl}/pulls?${searchParameters}`, token, "Bearer");
    const pullRequest = pullRequests[0];
    return pullRequest ? { number: pullRequest.number, title: pullRequest.title, htmlUrl: pullRequest.html_url } : undefined;
}

async function addReviewNeededLabel(repositoryUrl: string, token: string, pullRequestNumber: number): Promise<void> {
    await addLabel(repositoryUrl, token, pullRequestNumber, "architecture-review-needed", "1d76db", "API architecture review is required.");
}

async function addLabel(repositoryUrl: string, token: string, pullRequestNumber: number, labelName: string, color: string, description: string): Promise<void> {
    await ensureLabel(repositoryUrl, token, labelName, color, description);
    await gitHubRequest<unknown>(`${repositoryUrl}/issues/${pullRequestNumber}/labels`, token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            labels: [labelName],
        }),
    });
}

async function ensureLabel(repositoryUrl: string, token: string, labelName: string, color: string, description: string): Promise<void> {
    const labelResponse = await gitHubFetch(`${repositoryUrl}/labels/${encodeURIComponent(labelName)}`, token, "Bearer");
    if (labelResponse.ok) {
        return;
    }

    if (labelResponse.status !== 404) {
        throw new Error(`GitHub API request failed with status ${labelResponse.status}: ${await labelResponse.text()}`);
    }

    const createResponse = await gitHubFetch(`${repositoryUrl}/labels`, token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            name: labelName,
            color,
            description,
        }),
    });
    if (createResponse.ok || createResponse.status === 422) {
        return;
    }

    throw new Error(`GitHub API request failed with status ${createResponse.status}: ${await createResponse.text()}`);
}

async function removeLabel(repositoryUrl: string, token: string, pullRequestNumber: number, labelName: string): Promise<void> {
    const response = await gitHubFetch(`${repositoryUrl}/issues/${pullRequestNumber}/labels/${encodeURIComponent(labelName)}`, token, "Bearer", {
        method: "DELETE",
    });
    if (response.ok || response.status === 404) {
        return;
    }

    throw new Error(`GitHub API request failed with status ${response.status}: ${await response.text()}`);
}

async function upsertReviewOutOfDateComment(
    repositoryUrl: string,
    token: string,
    pullRequestNumber: number,
    operationId: string,
    pipelineUrl: string | undefined,
): Promise<void> {
    const body = createReviewOutOfDateCommentBody(operationId, pipelineUrl);
    const existingComments = await findReviewOutOfDateComments(repositoryUrl, token, pullRequestNumber);
    const existingComment = existingComments.at(-1);
    if (existingComment) {
        await updateIssueComment(repositoryUrl, token, existingComment.id, body);
        await deleteReviewOutOfDateComments(repositoryUrl, token, existingComments.filter((comment) => comment.id !== existingComment.id));
        return;
    }

    await gitHubRequest<unknown>(`${repositoryUrl}/issues/${pullRequestNumber}/comments`, token, "Bearer", {
        method: "POST",
        body: JSON.stringify({ body }),
    });
}

async function updateReviewOutOfDateCommentToInSync(repositoryUrl: string, token: string, pullRequestNumber: number, operationId: string | undefined): Promise<void> {
    const existingComments = await findReviewOutOfDateComments(repositoryUrl, token, pullRequestNumber);
    const existingComment = existingComments.at(-1);
    if (!existingComment) {
        return;
    }

    await updateIssueComment(repositoryUrl, token, existingComment.id, createReviewInSyncCommentBody(operationId));
    await deleteReviewOutOfDateComments(repositoryUrl, token, existingComments.filter((comment) => comment.id !== existingComment.id));
}

async function updateIssueComment(repositoryUrl: string, token: string, commentId: number, body: string): Promise<void> {
    await gitHubRequest<unknown>(`${repositoryUrl}/issues/comments/${commentId}`, token, "Bearer", {
        method: "PATCH",
        body: JSON.stringify({ body }),
    });
}

async function hasDifferentReviewOutOfDateOperation(
    repositoryUrl: string,
    token: string,
    pullRequestNumber: number,
    operationId: string,
): Promise<boolean> {
    const existingComment = await findLatestReviewOutOfDateComment(repositoryUrl, token, pullRequestNumber);
    return existingComment !== undefined && !existingComment.body?.includes(createReviewOutOfDateOperationMarker(operationId));
}

async function findLatestReviewOutOfDateComment(
    repositoryUrl: string,
    token: string,
    pullRequestNumber: number,
): Promise<GitHubIssueCommentResponse | undefined> {
    return (await findReviewOutOfDateComments(repositoryUrl, token, pullRequestNumber)).at(-1);
}

async function findReviewOutOfDateComments(
    repositoryUrl: string,
    token: string,
    pullRequestNumber: number,
): Promise<GitHubIssueCommentResponse[]> {
    const matchingComments: GitHubIssueCommentResponse[] = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
        const searchParameters = new URLSearchParams({ per_page: perPage.toString(), page: page.toString() });
        const comments = await gitHubRequest<GitHubIssueCommentResponse[]>(`${repositoryUrl}/issues/${pullRequestNumber}/comments?${searchParameters}`, token, "Bearer");
        matchingComments.push(...comments.filter((comment) => comment.body?.includes(reviewOutOfDateCommentMarker)));
        if (comments.length < perPage) {
            return matchingComments;
        }
    }
}

async function deleteReviewOutOfDateComments(
    repositoryUrl: string,
    token: string,
    comments: GitHubIssueCommentResponse[],
): Promise<void> {
    for (const comment of comments) {
        const response = await gitHubFetch(`${repositoryUrl}/issues/comments/${comment.id}`, token, "Bearer", {
            method: "DELETE",
        });
        if (response.ok || response.status === 404) {
            continue;
        }

        throw new Error(`GitHub API request failed with status ${response.status}: ${await response.text()}`);
    }
}

function createReviewOutOfDateCommentBody(operationId: string, pipelineUrl: string | undefined): string {
    return [
        reviewOutOfDateCommentMarker,
        createReviewOutOfDateOperationMarker(operationId),
        pipelineUrl
            ? `${reviewOutOfDateCommentText} Monitor the progress here: ${pipelineUrl}`
            : reviewOutOfDateCommentText,
    ].join("\n");
}

function createReviewInSyncCommentBody(operationId: string | undefined): string {
    return [
        reviewOutOfDateCommentMarker,
        operationId ? createReviewOutOfDateOperationMarker(operationId) : undefined,
        reviewInSyncCommentText,
    ].filter((line) => line !== undefined).join("\n");
}

function createReviewOutOfDateOperationMarker(operationId: string): string {
    return `<!-- api-review-hub:operation:${operationId} -->`;
}

async function resolveArchitectReviewers(
    repositoryUrl: string,
    token: string,
    packageRelativePath: string,
): Promise<ArchitectReviewers> {
    const architects = await readArchitectsFile(repositoryUrl, token);
    if (!architects) {
        return { users: [], teams: [] };
    }

    const owners = findMatchingOwners(architects, packageRelativePath);
    return {
        users: owners.filter((owner) => !owner.includes("/")),
        teams: owners.filter((owner) => owner.includes("/")).map((owner) => owner.split("/").at(-1)!),
    };
}

async function readArchitectsFile(repositoryUrl: string, token: string): Promise<string | undefined> {
    return readRepositoryFile(repositoryUrl, token, architectsFilePath, architectsFileRef);
}

async function readRepositoryFile(repositoryUrl: string, token: string, path: string, ref: string): Promise<string | undefined> {
    const searchParameters = new URLSearchParams({ ref });
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await gitHubFetch(`${repositoryUrl}/contents/${encodedPath}?${searchParameters}`, token, "Bearer");
    if (response.status === 404) {
        return undefined;
    }

    if (!response.ok) {
        throw new Error(`GitHub API request failed with status ${response.status}: ${await response.text()}`);
    }

    const content = await response.json() as GitHubContentResponse;
    if (content.encoding !== "base64" || !content.content) {
        throw new Error(`GitHub file response for '${path}' did not include base64 content.`);
    }

    return Buffer.from(content.content, "base64").toString("utf8");
}

function getApiHashFromMetadata(metadata: unknown): string | undefined {
    if (typeof metadata !== "object" || metadata === null) {
        return undefined;
    }

    const record = metadata as Record<string, unknown>;
    const apiMdSha256 = record["apiMdSha256"];
    return typeof apiMdSha256 === "string" && apiMdSha256.length > 0 ? apiMdSha256 : undefined;
}

function findMatchingOwners(architects: string, packageRelativePath: string): string[] {
    const normalizedPath = normalizePackageRelativePath(packageRelativePath);
    const entries = parseArchitectEntries(architects);

    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (matchesArchitectPattern(entry.pattern, normalizedPath)) {
            return entry.owners;
        }
    }

    return [];
}

function parseArchitectEntries(architects: string): ArchitectEntry[] {
    const entries: ArchitectEntry[] = [];
    for (const rawLine of architects.split(/\r?\n/)) {
        const line = stripCodeownersComment(rawLine).trim();
        if (!line) {
            continue;
        }

        const [pattern, ...owners] = line.split(/\s+/);
        const normalizedOwners = owners.map(normalizeArchitectOwner).filter((owner): owner is string => owner !== undefined);
        if (pattern && normalizedOwners.length > 0) {
            entries.push({ pattern, owners: normalizedOwners });
        }
    }

    return entries;
}

function matchesArchitectPattern(pattern: string, packageRelativePath: string): boolean {
    const normalizedPattern = normalizePackageRelativePath(pattern);
    if (normalizedPattern === ".") {
        return true;
    }

    if (!containsGlob(normalizedPattern)) {
        return packageRelativePath === normalizedPattern || packageRelativePath.startsWith(`${normalizedPattern}/`);
    }

    return createArchitectPatternRegExp(normalizedPattern).test(packageRelativePath);
}

function stripCodeownersComment(line: string): string {
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith("#")) {
        return "";
    }

    return line.replace(/\s+#.*$/, "");
}

function normalizeArchitectOwner(owner: string): string | undefined {
    const normalizedOwner = owner.trim().replace(/^@/, "");
    return normalizedOwner.length > 0 ? normalizedOwner : undefined;
}

function containsGlob(pattern: string): boolean {
    return /[*?]/.test(pattern);
}

function createArchitectPatternRegExp(pattern: string): RegExp {
    let expression = "";
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index]!;
        if (character === "*") {
            if (pattern[index + 1] === "*") {
                expression += ".*";
                index++;
            } else {
                expression += "[^/]*";
            }
            continue;
        }

        if (character === "?") {
            expression += "[^/]";
            continue;
        }

        expression += escapeRegExp(character);
    }

    return new RegExp(`^${expression}($|/)`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function requestReviewers(
    repositoryUrl: string,
    token: string,
    pullRequestNumber: number,
    reviewers: { users: string[]; teams: string[] },
): Promise<boolean> {
    const response = await gitHubFetch(`${repositoryUrl}/pulls/${pullRequestNumber}/requested_reviewers`, token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            reviewers: reviewers.users,
            team_reviewers: reviewers.teams,
        }),
    });

    if (response.ok) {
        return true;
    }

    console.warn(JSON.stringify({
        event: "architectReviewerRequestFailed",
        pullRequestNumber,
        reviewers,
        status: response.status,
        responseBody: await response.text(),
    }));
    return false;
}

async function addArchitectFallbackComment(
    repositoryUrl: string,
    token: string,
    pullRequestNumber: number,
    reviewers: { users: string[]; teams: string[] },
): Promise<void> {
    const architectMentions = [
        ...reviewers.users.map((user) => `@${user}`),
        ...reviewers.teams.map((team) => `@${team}`),
    ];
    if (architectMentions.length === 0) {
        return;
    }

    await gitHubRequest<unknown>(`${repositoryUrl}/issues/${pullRequestNumber}/comments`, token, "Bearer", {
        method: "POST",
        body: JSON.stringify({
            body: `cc/ architect ${architectMentions.join(" ")}`,
        }),
    });
}

function createReviewPullRequestBody(options: {
    readonly repositoryUrl: string;
    readonly packageName: string;
    readonly baseRef: string;
    readonly targetRef: string;
    readonly baseVersion: string;
    readonly targetVersion: string;
    readonly workingPullRequest: GitHubPullRequestReference | undefined;
}): string {
    const workingBranchName = getRefDisplayName(options.targetRef, "heads");
    const baselineTagName = getRefDisplayName(options.baseRef, "tags");
    const workingBranchUrl = `${options.repositoryUrl.replace("https://api.github.com/repos/", "https://github.com/")}/tree/${encodeURIComponent(workingBranchName)}`;
    const baselineTagUrl = `${options.repositoryUrl.replace("https://api.github.com/repos/", "https://github.com/")}/releases/tag/${encodeURIComponent(baselineTagName)}`;
    const workingReferenceLine = options.workingPullRequest
        ? `- **Working PR:** pull request [#${options.workingPullRequest.number} ${options.workingPullRequest.title}](${options.workingPullRequest.htmlUrl}) (version ${options.targetVersion})`
        : `- **Working branch:** branch [\`${workingBranchName}\`](${workingBranchUrl}) (version ${options.targetVersion})`;

    return [
        `Automated API review PR for ${options.packageName}.`,
        "",
        workingReferenceLine,
        `- **Baseline:** tag [\`${baselineTagName}\`](${baselineTagUrl}) (version ${options.baseVersion})`,
        "",
        "Generated by API Review Hub.",
    ].join("\n");
}

function normalizePackageRelativePath(packageRelativePath: string): string {
    return packageRelativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || ".";
}

function getRefDisplayName(ref: string, refKind: "heads" | "tags"): string {
    const normalizedRef = ref.replace(/^refs\//, "");
    return normalizedRef.startsWith(`${refKind}/`) ? normalizedRef.slice(refKind.length + 1) : normalizedRef;
}

function toHeadsRef(branchOrRef: string): string {
    const normalizedRef = branchOrRef.replace(/^refs\//, "");
    return normalizedRef.startsWith("heads/") ? normalizedRef : `heads/${normalizedRef}`;
}

function getCandidateRefs(ref: string, kinds: readonly ("heads" | "tags")[]): string[] {
    const normalizedRef = ref.replace(/^refs\//, "");
    if (normalizedRef.startsWith("heads/") || normalizedRef.startsWith("tags/")) {
        return [normalizedRef];
    }

    return kinds.map((kind) => `${kind}/${normalizedRef}`);
}

function encodeGitRefPath(ref: string): string {
    return ref.split("/").map(encodeURIComponent).join("/");
}