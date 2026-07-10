# Proposal: API Review Hub

## Objective

Create API Review Hub, a new TypeScript web application that coordinates API review workflows on GitHub.

This service must be independent from the existing APIView application and the Python `apiview-copilot` package. It must not reuse APIView or APIView Copilot runtime code, data stores, deployment infrastructure, or service-specific assumptions. Existing systems may call the new service through explicit APIs, but the new web app owns its own hosting, configuration, persistence, authentication, and operational model.

The new service will:

- Accept GitHub App webhook events from repositories where the dedicated API Review Hub GitHub App is installed, then filter and correlate the events needed for API review workflows.
- Validate all incoming GitHub webhook requests before taking any other actions.
- Expose a small set of required APIs and allow additional custom API endpoints to be added over time.
- Store API review workflow metadata in Cosmos DB.
- Use the dedicated `api-review-hub` GitHub App for repository actions and app-level webhook delivery.
- Use Entra ID authentication where appropriate.
- Use managed identities to access Azure resources.
- Run as separate production and staging resource stamps.

---

## Key Architecture Decision

The GitHub API review workflow should be implemented as a new TypeScript service rather than as a continuation of APIView or APIView Copilot.

This keeps the new GitHub-centered workflow from inheriting APIView UI-era assumptions, parser-specific implementation details, Copilot review pipeline behavior, or existing deployment coupling. It also avoids binding the new TypeScript service to the legacy APIView and APIView Copilot language stacks. APIView and APIView Copilot can remain independent systems while this service focuses on subscribed GitHub event ingestion, workflow state, release-gating metadata, and repository automation. That separation creates a clean path to retire the legacy APIView and APIView Copilot systems once the GitHub workflow has replaced their required responsibilities.

---

## Approach Tradeoffs

API Review Hub is intentionally a skinny workflow and state service. GitHub remains the review surface, Azure DevOps remains the release pipeline entry point, and API Review Hub coordinates the state and automation that would otherwise be spread across GitHub webhooks, Azure DevOps work items, and pipeline scripts.

The main reason to consider this service approach is that the earlier serverless plan depended on GitHub Actions connecting to Azure DevOps through OIDC, and that connection model is considered insecure for this workflow. Because that was a foundational requirement for keeping the implementation entirely in GitHub and Azure DevOps automation, API Review Hub provides a narrower service boundary where repository automation can use the GitHub App and managed identity instead.

| Benefit | Impact |
|---|---|
| Centralized workflow state | Review PR status, approval state, package version state, release gate decisions, and webhook processing state can be queried from one service instead of inferred from GitHub, Azure DevOps, and pipeline history. |
| Simpler pipelines and scripts | API Review Hub owns workflow orchestration and GitHub mutations while Azure DevOps remains responsible for artifact generation, allowing repository scripts to become fewer, smaller, and more consistent. |
| GitHub-first review experience | Architects and service teams continue to review in GitHub, while API Review Hub stores the durable state projection needed for automation and release gating. |
| Better automation boundary | GitHub App operations, app-level webhook validation, branch synchronization, and review PR cleanup are owned by one service instead of scattered through scripts. |
| Reduced pipeline credential risk | Repository automation can use the GitHub App and managed service identity rather than expanding Azure DevOps OIDC-based access patterns across many language-specific pipelines. |
| Future extensibility | Additional agents, dashboards, or release planner integrations can query API Review Hub through explicit APIs rather than scraping GitHub or Azure DevOps state. |

| Cost or Risk | Impact |
|---|---|
| Continued service maintenance | API Review Hub still requires hosting, deployment, monitoring, incident response, and long-term ownership, similar to APIView today. |
| Azure resource ownership | The team that owns API Review Hub must also own the App Service, Cosmos DB, Key Vault, App Configuration, Application Insights, managed identities, and deployment configuration. |
| Central team ownership | API review workflow ownership remains concentrated in one service team instead of being fully dispersed to individual language teams. |
| Additional persisted state | The service must keep its Cosmos DB projection consistent with GitHub events, release pipeline calls, and any migrated Azure DevOps metadata. |
| Failure modes remain service-centered | If API Review Hub is unavailable or stale, review PR creation, release gates, or cleanup automation may be blocked or require fallback behavior, as with APIView-owned workflows today. |

The alternative is to keep the workflow distributed across GitHub, Azure DevOps, and pipeline scripts. That avoids introducing a new hosted service, but it pushes coordination logic into less discoverable places, makes approval state harder to query consistently, and makes future agent or dashboard scenarios depend on scraping or reimplementing workflow logic.

---

## Technology Stack

- Runtime: Node.js on Azure App Service.
- Language: TypeScript.
- HTTP server: Node.js built-in HTTP APIs.
- Persistence: Azure Cosmos DB.
- Configuration: Azure App Configuration.
- Secrets and GitHub App private key material: Azure Key Vault.
- Telemetry: Application Insights.
- Authentication: Microsoft Entra ID for service APIs where appropriate.
- Azure resource access: Managed identities.

The implementation should start with the built-in Node.js HTTP APIs rather than introducing an application framework. Every dependency adds potential vulnerability, maintenance, and supply-chain risk, so the service should use the minimum dependency set needed for the required behavior. Additional routing, middleware, validation, OpenAPI, or authentication libraries should require a concrete implementation need.

---

## Azure Resource Model

Each environment stamp must include the following resources:

| Resource | Purpose |
|---|---|
| App Service Plan | Dedicated compute plan for the web app. |
| Web App | Hosts the TypeScript service. |
| Key Vault | Stores secrets, GitHub App key material or signing keys, the app-level webhook secret, and other sensitive configuration. |
| App Configuration | Stores non-secret runtime configuration, feature switches, environment settings, and endpoint configuration. |
| Cosmos DB | Stores workflow metadata, webhook processing state, custom endpoint metadata, release-gating lookup records, and idempotency records. |
| Application Insights | Stores request telemetry, dependency telemetry, traces, exceptions, and operational events. |

### Environment Stamps

The service must be deployed as separate production and staging copies:

| Environment | Purpose |
|---|---|
| Production | Primary live service for API review GitHub workflows. The production Web App must use deployment slots, including a staging slot used by the deployment pipeline before swap. |
| Staging | Pre-production validation environment for integration tests, deployment verification, and GitHub workflow testing. |

Production and staging should not share mutable runtime state. Configuration and secrets should be promoted intentionally, not edited independently by hand.

The production staging slot is an App Service deployment slot, not the separate staging environment stamp. The pipeline should deploy production builds to the staging slot first, validate the slot, and require an explicit slot swap to move the build into production. Keeping the previous production slot available after swap provides a fast rollback path to the last known-good application and configuration if the new deployment fails.

---

## Required Service Endpoints

All API Review Hub HTTP endpoints must live under the `/api` URL group so service API traffic is consistently identifiable by path.

### GitHub Webhook Endpoint

The service must provide a GitHub webhook endpoint. The exact route can be finalized during implementation, but the service must reserve a stable endpoint such as:

```http
POST /api/github/webhook-events
```

The endpoint must:

- Validate every incoming GitHub webhook request, including signature, delivery ID, event type, and repository metadata.
- Support app-level GitHub App event delivery using the single webhook secret configured on the GitHub App.
- Receive events for repositories where the GitHub App is installed and decide in service code which events apply to API review workflows.
- Deduplicate deliveries using GitHub delivery IDs.
- Persist webhook receipt and processing state in Cosmos DB.
- Process events idempotently.
- Return quickly after durable acceptance, with longer work delegated to an internal processing path.
- Produce structured telemetry for event type, delivery ID, repository, processing result, and failure reason.

The app-level webhook secret is stored in Key Vault and referenced by App Configuration. Repository registrations track whether a repository is enabled for API Review Hub processing.

### Custom API Endpoints

The service must allow custom API endpoints to be added without changing the GitHub webhook contract.

Custom endpoints should be added for specific workflow actions or queries, such as:

- Requesting creation of API review pull requests.
- Returning release-gating decisions.

Custom endpoints that mutate state or expose non-public metadata must use Entra ID authentication unless there is a specific documented reason to use another authentication model.

### Endpoint Summary

The current service implementation exposes the following endpoints under `/api`.

The following endpoints are required for the end-to-end review and release process.

| Endpoint | Primary User | Purpose |
|---|---|---|
| `POST /api/github/webhook-events` | GitHub | Accepts GitHub webhook deliveries so API Review Hub can respond to and synchronize with GitHub changes, including review activity, pushed commits, pull request lifecycle changes, and other workflow events. |
| `POST /api/review-prs` | User/Agent | Requests creation of a GitHub API review pull request for a package API change. This is an LRO that returns an operation ID. |
| `GET /api/operations/{operationId}` | User/Agent | Gets the status of an async operation and returns the created review pull request when the operation succeeds. |
| `POST /api/operations/{operationId}` | ADO | Accepts an authenticated Azure DevOps update after operation artifacts are published. |
| `GET /api/releases/check-gate` | ADO | Evaluates whether a package version and API hash have the approval needed for release. |
| `POST /api/releases/mark-released` | ADO | Marks a package version as released after the release pipeline succeeds. Returns only a status code on success. |

The TypeSpec contract also sketches secondary query endpoints for agentic queries and a simple dashboard. These are contract-level follow-ups, not current router implementations.

| Endpoint | Primary User | Purpose |
|---|---|---|
| `GET /api/review-prs` | User/Agent | Lists review pull requests known to API Review Hub, optionally filtered by package language or working branch. |
| `GET /api/review-prs/{githubRepositoryId}/{pullRequestNumber}` | User/Agent | Gets a review pull request by stable GitHub repository ID and pull request number. |
| `POST /api/review-prs/resolve` | User/Agent | Functionally similar to `GET /api/review-prs/{githubRepositoryId}/{pullRequestNumber}`, but resolves a review pull request using values callers are more likely to know, such as a review PR URL or package coordinates. |
| `GET /api/services` | User/Agent | Lists service groupings known to API Review Hub. |
| `GET /api/services/{serviceId}` | User/Agent | Gets service metadata and associated packages. |
| `GET /api/packages` | User/Agent | Lists package records known to API Review Hub, optionally filtered by language or service. |
| `GET /api/packages/{packageId}` | User/Agent | Gets package metadata by package identifier. |
| `GET /api/packages/{packageId}/versions` | User/Agent | Lists version records for a package. |
| `POST /api/packages/resolve` | User/Agent | Functionally similar to getting a package or package version by API Review Hub identifiers, but resolves using values callers are more likely to know, such as package coordinates or a review PR URL, instead of opaque API Review Hub IDs. Returns a wrapper object with a `kind` field indicating whether the resolved resource is a package or package version. |
| `GET /api/health` | User/Agent | Returns service health for probes and operational checks. |

### Workflow Scenarios

#### Create Review Pull Request

1. A user or automation requests a review pull request with `POST /api/review-prs`.
2. API Review Hub accepts the request and returns an operation ID.
3. API Review Hub queues the configured Azure DevOps artifact generation pipeline.
4. Azure DevOps generates the API artifacts and calls `POST /api/operations/{operationId}` when the pipeline run completes.
5. API Review Hub verifies the callback, downloads the generated artifacts from Azure DevOps, and uses the `api-review-hub` GitHub App to create the required synthetic branches and open the review pull request.
6. API Review Hub assigns the appropriate architect reviewers and applies the managed API approval label state.
7. API Review Hub records the review pull request, associates it with the package version, and initializes approval state as `pending`.
8. The caller can query `GET /api/operations/{operationId}` to retrieve the created review pull request after the operation succeeds.

#### Architect Review

1. The architect submits their review in GitHub.
2. GitHub sends a webhook delivery to `POST /api/github/webhook-events`.
3. API Review Hub validates the webhook signature, delivery metadata, repository, and actor.
4. API Review Hub determines whether the review represents an approval, rejection, revocation, or other supported review state change.
5. API Review Hub updates the approval record associated with the review pull request and package version.
6. API Review Hub synchronizes the managed API approval labels on the original working pull request, when one exists for the reviewed working branch.

#### Working Pull Request Label Coordination

API Review Hub coordinates approval visibility back to the original service-team working pull request. The API review pull request remains the review artifact surface, but the working pull request gets managed labels that summarize the current API review state for release and merge workflows.

The managed labels are:

| Label | Meaning |
|---|---|
| `api-approved` | The API review state for the working pull request is approved. |
| `api-changes-requested` | The API review state for the working pull request is rejected or requires changes. |

These labels are owned by API Review Hub. When approval state changes, the service finds the open working pull request for the recorded working branch and applies the expected label while removing the opposite label. If neither approved nor rejected state applies, the service removes both managed labels.

If a user manually adds or removes one of these managed labels, GitHub sends an issue label webhook. API Review Hub evaluates the current release-gate decision for the associated review workflow and either allows the change when it matches the expected state or reverts it and comments that the label is managed by API Review Hub. If the label is added to a pull request or issue that is not associated with an API Review Hub workflow, the service removes it.

#### Updates Pushed

1. GitHub sends a webhook delivery when a new commit is pushed.
2. API Review Hub checks whether the pushed branch is a working branch for any open review pull request.
3. API Review Hub checks whether the changed files are relevant to the package targeted by each matching review pull request.
4. When the branch and changed package match a known review workflow, API Review Hub queues the configured Azure DevOps artifact generation pipeline to refresh the target artifact.
5. After Azure DevOps calls back, API Review Hub verifies the callback and uses the GitHub App to update the review branch with the refreshed artifact.
6. API Review Hub updates review pull request state as needed so later lookup and release-gate calls observe the current review state.

#### Release

1. The service team triggers the release pipeline in Azure DevOps.
2. The release pipeline calls `GET /api/releases/check-gate` with package language, package name, version, and API hash.
3. API Review Hub checks whether the package version has a matching approved API hash and no later state has made the approval stale.
4. During the transition from APIView to API Review Hub, API Review Hub also checks the existing APIView release gate.
5. If either the API Review Hub gate or the APIView gate allows release, the pipeline proceeds.
6. After a successful release, the pipeline calls `POST /api/releases/mark-released`.
7. API Review Hub records the package version as released and uses the GitHub App to close the associated review pull request when appropriate.

#### Review Pull Request Cleanup

1. A service team or API Review Hub closes or merges the review pull request in GitHub.
2. GitHub sends a webhook delivery to `POST /api/github/webhook-events`.
3. API Review Hub updates the review pull request lifecycle status to `closed` or `merged`.
4. API Review Hub uses the GitHub App to delete synthetic base and review branches when cleanup is safe.
5. The review pull request remains available in GitHub, and API Review Hub preserves the historical review record.

#### Webhook Secret Management

1. API Review Hub uses one app-level webhook secret configured on the dedicated GitHub App.
2. The secret value is stored in Key Vault, and App Configuration stores the Key Vault secret name in `github_webhook_secret_key`.
3. The webhook endpoint validates each delivery signature against that one app-level secret before reading repository registration state or mutating workflow data.
4. Repository registrations are used to decide whether a validated repository is enabled for API Review Hub processing.
5. The app-level webhook secret must be rotated every 90 days as an operational security policy.
6. Webhook secret rotation is a coordinated environment operation: update the GitHub App webhook secret, update the Key Vault secret value referenced by App Configuration, and verify new webhook deliveries immediately after the change.

#### GitHub App Private Key Rotation

API Review Hub signs GitHub App JWTs by using the GitHub App private key stored as Key Vault key material. The private key must be rotated every 90 days as an operational security policy.

GitHub App private key rotation should follow this sequence:

1. Generate a new private key from the `api-review-hub` GitHub App settings.
2. Import the new private key into Key Vault under the configured GitHub App key name, or update App Configuration to reference the new Key Vault key name if a new name is required.
3. Ensure the API Review Hub managed identity has crypto access to the Key Vault key used for signing.
4. Redeploy or refresh configuration if the key name changed.
5. Verify API Review Hub can create GitHub App JWTs and exchange them for installation tokens.
6. Delete the retired private key from the GitHub App after the new key is verified.
7. Disable or remove retired Key Vault key versions after the rollback window closes.

---

## GitHub App Integration

The service coordinates with the dedicated `api-review-hub` GitHub App for repository actions and GitHub webhook delivery.

Examples include:

- Creating or updating branches used for API review artifacts.
- Opening or updating API review pull requests.
- Posting comments or status summaries.
- Applying labels.
- Requesting reviewers.
- Closing or updating review PRs in response to lifecycle events.

The service should use GitHub App installation tokens scoped to the target repository. GitHub App identity, installation metadata, and key material should be stored or referenced through App Configuration and Key Vault. Where practical, private key material should remain in Key Vault and signing should use Key Vault-backed cryptography rather than loading long-lived private keys into application memory.

Repository operations must be limited to repositories where the GitHub App is installed and authorized. The service also requires an active repository registration keyed by stable GitHub repository ID before it processes webhook deliveries for that repository.

---

## Authentication and Authorization

- The web app must use managed identity for Azure resource access.
- Cosmos DB access should use Microsoft Entra ID and managed identity, not static account keys, unless a temporary migration exception is approved.
- Key Vault access must use managed identity.
- App Configuration access must use managed identity.
- Application Insights ingestion should use managed identity or platform-supported connection configuration.
- Custom service APIs must use Entra ID authentication where appropriate.
- GitHub webhook requests must be authenticated by validating GitHub signatures.
- GitHub repository actions must use `api-review-hub` GitHub App installation tokens.

The service should distinguish between trusted automation, GitHub webhook callers, and human administrative callers. Each API surface should document its expected caller and authorization model.

---

## Cosmos DB Data Model Sketch

Cosmos DB should store only the data needed for workflow coordination, idempotency, release-gating lookup, and diagnostics.

Suggested logical containers include:

| Container | Purpose |
|---|---|
| `services` | Service records that group related language packages, such as Azure Storage Blobs. |
| `packages` | Package records keyed by language and package name, with service association. |
| `packageVersions` | Version records with release status, API hash, approval state, and review PR links. |
| `approvalRecords` | API approval records keyed for release-gate lookup, including package version, API hash, approval status, pull request URL, reviewer identity, and update time. |
| `reviewPullRequests` | Review pull request records associated with package versions, including GitHub PR identity, branch metadata, approval state, and lifecycle status. |
| `adoOperations` | Azure DevOps operation records keyed by API Review Hub operation ID, including queued pipeline metadata, operation status, callback state, and failure details. |
| `webhookEvents` | GitHub delivery IDs, event metadata, processing status, retry state, and failure details. |
| `repositoryRegistrations` | Linked repository records keyed by stable GitHub repository ID, including repository full name, active/disabled status, update time, and optional deletion marker. |

The final partitioning strategy should be chosen around the most common access patterns: webhook correlation, package lookup by language and package name, release-gating lookup by package version and API hash, operation lookup by operation ID, and operational inspection by delivery ID.

Configured retention periods are:

| Container | Retention |
|---|---|
| `services` | 180 days |
| `packages` | 180 days |
| `packageVersions` | 180 days |
| `approvalRecords` | 180 days |
| `reviewPullRequests` | 90 days |
| `repositoryRegistrations` | 90 days |
| `adoOperations` | 30 days |
| `webhookEvents` | 30 days |

---

## Configuration and Secret Management

App Configuration should hold non-secret settings such as:

- Environment name.
- GitHub App ID, GitHub App signing key reference, and GitHub webhook secret reference.
- Feature switches.
- Custom endpoint enablement.
- Cosmos DB database and container names.

Key Vault should hold secrets and sensitive values such as:

- The GitHub App webhook secret.
- GitHub App private key material or Key Vault key references.
- Emergency break-glass secrets, if any are approved.
- Any external service credentials that cannot use managed identity.

Configuration should be deployed consistently across production and staging. Manual portal edits should be reserved for emergency operations and captured afterward as source-controlled configuration changes.

---

## Reliability and Operations

- Webhook processing must be retry-safe and idempotent.
- Duplicate GitHub deliveries must not create duplicate state transitions.
- Out-of-order GitHub events must not corrupt workflow state.
- Staging must be able to validate GitHub webhook delivery and GitHub App operations without affecting production repositories. Staging repository write access is controlled by where the `api-review-hub` GitHub App is installed and by active repository registrations.
- Application Insights must capture enough telemetry to explain webhook failures, GitHub App failures, authentication failures, and release-gating lookup failures.
- Operational dashboards should show webhook volume, processing failures, GitHub API failures, Cosmos DB throttling, and endpoint latency.

---

## Deployment Requirements

- Infrastructure should be source controlled.
- Deployments should be repeatable for production and staging.
- The build should compile TypeScript, run unit tests, and produce a deployable app artifact.
- The release process should deploy the staging environment first, then deploy the production build to the production Web App staging slot, validate it, and require an explicit slot swap before it serves production traffic.
- The release process should preserve the previous production slot as the last known-good version so rollback can be performed quickly by swapping slots back if the new deployment fails.
- Environment-specific values should come from App Configuration, Key Vault, managed identities, and deployment parameters rather than hard-coded application values.

---

## Non-Goals

- Reusing APIView runtime code or data stores.
- Reusing APIView Copilot runtime code or data stores.
- Recreating APIView's historical review UI.
- Implementing AI review generation in this service.
- Replacing unrelated `azure-sdk-automation` workflows outside API Review Hub.
- Storing long-lived GitHub user tokens.

---

## Open Questions

- Should API Review Hub support service-level release-gating exceptions, such as excluding management-plane packages from release gating?
- Should API Review Hub automatically approve package versions when the API hash matches another approved or released version, such as patch versions with unchanged API surface?

---

## Success Criteria

- The TypeScript web app is deployed independently from APIView and APIView Copilot.
- Production and staging resource stamps exist with the required Azure resources.
- The service accepts and validates GitHub webhooks.
- Webhook processing is idempotent and observable.
- The service can authenticate to Azure resources using managed identity.
- Custom service APIs can use Entra ID authentication.
- Repository actions are performed through `api-review-hub` GitHub App installation tokens.
- Cosmos DB stores review workflow state and webhook processing records needed for reliable operation.