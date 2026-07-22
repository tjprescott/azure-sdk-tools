# API Review Hub Deployment and Repository Migration Plan

## Objective

Move API Review Hub from this proof of concept into the Azure DevOps `azure-sdk-build-tools` repository, deploy isolated staging and production service stamps, and integrate the service with the existing SDK release pipeline infrastructure without coupling the service back to APIView runtime code.

## Ownership Boundaries

| Repository | Owns |
| --- | --- |
| `azure-sdk-build-tools` | API Review Hub server, TypeSpec contract, service tests, Azure infrastructure definitions, service deployment pipelines, runtime configuration, and operational documentation. |
| `azure-sdk-tools` | Shared Azure SDK release-pipeline integration, including the authenticated client that evaluates the API Review Hub release gate. |
| SDK language repositories, initially Python | Package-specific pipeline configuration and adoption of the shared release-gate integration. |

The service must not import APIView or `eng/common` runtime code. SDK release pipelines may call the Hub only through its documented HTTP API.

## Phase 1: Confirm the Service Contract

1. Confirm the production contract for `GET /api/releases/check-gate`, including required `language`, `packageName`, `version`, and `apiHash` inputs.
2. Confirm the response model, especially `allowed`, denial reasons, and returned approval metadata.
3. Define release-gate failure behavior. For production release validation, missing API hash, authorization failure, malformed response, timeout, and service failure must deny the release.
4. Define the Entra app registration, App ID URI, and audience for each service environment. Do not infer a production audience from the web app hostname.
5. Define the migration policy from legacy APIView approval to API Review Hub approval: shadow mode, pilot enforcement, broad enforcement, then legacy fallback retirement.

**Exit criteria:** The API contract, Entra audience, failure policy, and migration policy have an identified owner and are documented before pipeline callers are changed.

## Phase 2: Move the Service to `azure-sdk-build-tools`

1. Create an API Review Hub service directory in `azure-sdk-build-tools`, for example:

   ```text
   tools/api-review-hub/
     src/
     scripts/
       infra/
     tests/
     main.tsp
     package.json
     package-lock.json
     tsconfig.json
     README.md
     ci.yml
   ```

2. Move the server and contract assets from this proof of concept:
   - `src/`
   - `main.tsp`
   - `package.json`, `package-lock.json`, and `tsconfig.json`
   - `.env.example`
   - service architecture and operations documentation
3. Move the deployment and infrastructure code with the service:
   - `scripts/deploy-app.ts`
   - `scripts/infra/variables.ts`
   - `scripts/infra/variables.yaml`
   - `scripts/infra/create-resources.ts`
   - `scripts/infra/grant-resource-access.ts`
   - `scripts/infra/bootstrap-appconfig.ts`
4. Update relative imports, script paths, package metadata, and CI paths for the new location.
5. Do not move these as production dependencies:
   - `scripts/auth.ts`
   - `scripts/callback-operation.ts`
   - `scripts/check-release.ts`
   - `scripts/request-review-pr.ts`
   - `scripts/check-release-gate.ps1`
   - `scripts/infra/bootstrap-cosmos.ts` until its hard-coded repository registration is replaced with a supported onboarding mechanism.
6. Add a focused test suite for release-gate decisions, authorization, webhook validation, persistence mappings, and sanitized failures.
7. Validate the moved project with `npm ci`, `npm run check`, `npm run build`, TypeSpec validation, and the new tests.

**Exit criteria:** The service builds and tests from `azure-sdk-build-tools` with no dependency on this repository or `eng/common`.

## Phase 3: Production-Ready Infrastructure

1. Place the infrastructure definition beside the service in `azure-sdk-build-tools`. The current TypeScript ARM deployment script may be migrated first; convert it to the repository's approved infrastructure format if required by that repository.
2. Parameterize deployment by environment. Source control must not contain production subscription IDs, tenant IDs, secret names, or operational values.
3. Provision distinct, non-sharing staging and production stamps:
   - App Service plan and Linux Web App with system-assigned managed identity
   - Production deployment slot for pre-swap validation
   - Cosmos DB account, database, and all required containers
   - Azure App Configuration
   - Key Vault
   - Application Insights and alerting destination
   - Entra application registration and App ID URI
4. Set up Azure RBAC with least privilege:
   - Deployment identity may create and update resources.
   - Web app managed identity receives Cosmos data access, App Configuration read access, and only the Key Vault permissions it requires.
   - Bootstrap identity receives temporary or approved data-plane write access for initial configuration.
5. Move non-secret runtime values to App Configuration and secret/key material to Key Vault. Use pipeline variable groups or an equivalent protected configuration source only for deployment-time values.
6. Replace `bootstrap-cosmos.ts` hard-coded seed data with either an authenticated administration endpoint, a parameterized onboarding script, or a documented manual registration process.
7. Add health/readiness checks and telemetry for request failures, release-gate decisions, authentication failures, and Cosmos/App Configuration/Key Vault dependencies.

**Exit criteria:** Staging and production resources exist as separate stamps; the service identity can access its dependencies without static Azure credentials.

## Phase 4: Build and Deployment Pipelines

1. Add service CI in `azure-sdk-build-tools`:
   - dependency installation
   - TypeScript check and build
   - TypeSpec validation
   - unit tests
   - dependency and security checks required by the repository
   - a versioned deployment artifact
2. Add a staging deployment pipeline that deploys the CI artifact, bootstraps approved configuration, and executes authenticated smoke checks.
3. Add a production deployment pipeline that:
   - deploys the previously validated artifact to the production staging slot
   - runs health and release-gate smoke checks against the slot
   - requires production approval
   - swaps the slot only after checks succeed
   - preserves the prior slot deployment for rollback
4. Keep infrastructure changes separate from application deployment, with an explicit production approval boundary for resource, RBAC, and App Configuration changes.
5. Document rollback: slot swap reversal for code issues and a pipeline feature flag to disable Hub enforcement for caller issues.

**Exit criteria:** A service commit can be built, promoted to staging, validated, and deployed to production without a developer workstation.

## Phase 5: Update `azure-sdk-tools` Release Integration

1. Keep API Review Hub release-gate calling code in `azure-sdk-tools`, not in the Hub service repository.
2. Replace the current `eng/common` helper's hard-coded staging endpoint and audience with environment-configured values supplied by the release pipeline.
3. Create or extract a small self-contained PowerShell release-gate client that:
   - acquires an Entra access token for the configured Hub audience
   - calls `GET /api/releases/check-gate`
   - validates the response shape
   - logs the decision and safe diagnostic details
   - exits nonzero for a denied decision, missing API hash, or service/authentication failure
4. Retain the legacy APIView check during migration, but make the resolution rule explicit in the helper and pipeline output.
5. Update the release-validation template that currently uses API approval status. Do not add release-gate evaluation to the API-review creation template unless it is required to publish the API hash or review metadata.
6. Add PowerShell tests for approved, denied, missing-hash, unauthorized, timeout, malformed-response, and legacy-fallback scenarios.

**Exit criteria:** `azure-sdk-tools` can evaluate staging and production Hub release gates without importing or deploying Hub server code.

## Phase 6: Adopt in Python SDK Pipelines

1. Identify the existing Python release pipeline/template step that checks API approval.
2. Ensure that step supplies the exact package name, version, language, and generated API hash required by the Hub contract.
3. Update the Python repository's `eng/common` reference or shared pipeline template version to consume the new release-gate client.
4. Start with one pilot repository and known approved/denied test package versions.
5. Run the pilot in shadow mode first: call the Hub, record the decision, but preserve the current release result.
6. Compare Hub and legacy decisions; resolve any data, API-hash, or authorization mismatches.
7. Enable enforcement for the pilot, then roll out to the remaining Python repositories in controlled batches.

**Exit criteria:** The pilot repository demonstrates approved releases succeed and denied/missing-hash releases fail at the intended pipeline step with actionable output.

## Phase 7: Rollout and Retirement

1. Operate staging service and shadow-mode pipeline calls long enough to establish decision parity and service reliability.
2. Enforce the Hub gate for the pilot repository.
3. Expand enforcement to additional Python repositories after each rollout checkpoint.
4. Monitor telemetry, release failures, authorization failures, and dependency health throughout the rollout.
5. After the agreed adoption period, remove the legacy APIView approval fallback from `azure-sdk-tools`.
6. Remove the proof-of-concept service and scripts from this repository after the `azure-sdk-build-tools` deployment is authoritative and consumers have migrated.

## Required Documentation

Before production enforcement, publish:

- Service architecture, local setup, configuration, deployment, and incident-response documentation in `azure-sdk-build-tools`.
- Release-gate client inputs, pipeline variables, failure behavior, and troubleshooting documentation in `azure-sdk-tools`.
- SDK-team adoption guidance describing only the shared pipeline change and any package/API-hash prerequisites.
- CODEOWNERS and deployment approval ownership for the service, infrastructure, and shared release integration.
