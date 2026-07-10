# API Review Hub GitHub App Setup

This guide describes how to create a dedicated `api-review-hub` GitHub App for the API Review Hub proof of concept. Create the app directly under the `azure-sdk-engineering-system` GitHub organization.

The goal is to stop depending on the shared `azure-sdk-automation` app and give API Review Hub one app identity that can both perform repository automation and receive the webhook events needed to keep API review workflow state current.

## Current Implementation Note

The current service already authenticates to GitHub as a GitHub App by using a GitHub App ID and a Key Vault-backed signing key. The webhook handler validates app-level webhook deliveries with a single Key Vault secret configured by `GITHUB_WEBHOOK_SECRET_KEY`.

The app registration described here is the app identity API Review Hub should use. Fully automatic onboarding should handle GitHub App installation events, upsert allowed repository registrations, and process repository events delivered by the GitHub App webhook.

## Ownership Plan

GitHub supports registering a GitHub App under an organization where you have permission to manage GitHub Apps. For API Review Hub, the app should be owned by the `azure-sdk-engineering-system` organization from the start so the app identity, private keys, and repository installations are not tied to an individual account.

For this proof of concept:

1. Create the app under `azure-sdk-engineering-system`.
2. Use the app name `api-review-hub`.
3. Keep app managers limited to the engineering system owners who need to maintain the registration.
4. Make the app installable by other accounts because it must be installed on the Azure SDK language repositories.
5. Confirm app managers, webhook URLs, installed repositories, permissions, and the App ID used by API Review Hub before wiring the app into App Configuration.

## Create The App

Open GitHub and create a new GitHub App from the `azure-sdk-engineering-system` organization settings:

1. Go to the `azure-sdk-engineering-system` organization page.
2. Open **Settings**.
3. Open **Developer settings**.
4. Open **GitHub Apps**.
5. Select **New GitHub App**.

Use these registration values:

| Field | Value |
| --- | --- |
| GitHub App name | `api-review-hub` |
| Description | `Coordinates Azure SDK API review workflows.` |
| Homepage URL | The API Review Hub app URL, or this repository URL until the service has a stable public URL. |
| Callback URL | Leave blank unless API Review Hub later needs user OAuth authorization. |
| Expire user authorization tokens | Leave enabled. This app should not need user tokens for the current design. |
| Request user authorization during installation | Disabled. |
| Enable Device Flow | Disabled. |
| Setup URL | Optional. Leave blank until there is an API Review Hub setup page. |
| Webhook active | Enabled. |
| Webhook URL | `https://<api-review-hub-host>/api/github/webhook-events` |
| Webhook secret | Use a generated temporary secret for app installation events. Store the value in Key Vault if service code will validate app-level installation webhooks. |
| SSL verification | Enabled. |
| Where can this GitHub App be installed? | `Any account`, because API Review Hub must be installable on the Azure SDK language repositories outside `azure-sdk-engineering-system`. |

After creating the app, make the GitHub App public from the app settings so accounts outside `azure-sdk-engineering-system` can install it. `Any account` controls the allowed installation scope, but the app still needs to be public for external account installs.

## Repository Permissions

Grant the minimum repository permissions needed by the current API Review Hub GitHub operations:

| Permission | Access | Why API Review Hub needs it |
| --- | --- | --- |
| Metadata | Read-only | Required for GitHub Apps and repository identity lookup. |
| Contents | Read and write | Read package metadata and `.github/ARCHITECTS`; create commits, trees, blobs, and synthetic API review branches; delete cleanup branches. |
| Pull requests | Read and write | Create and update API review pull requests, read pull request state, and request reviewers. |
| Issues | Read and write | Create and update labels and comments on pull requests, which GitHub exposes through issue APIs. |

Do not grant Administration, Actions, Checks, Deployments, Environments, Secrets, Workflows, Members, or Organization permissions unless a later feature explicitly needs them.

## Webhook Events

Subscribe the GitHub App to these events:

| Event | Why API Review Hub needs it |
| --- | --- |
| Push | Detect working branch changes and queue review PR updates. |
| Pull request | Track review PR lifecycle changes and managed API approval label changes. |
| Pull request review | Convert architect approvals and changes requested into API approval records. |
| Issues | Handle managed API approval label changes that GitHub sends as issue events. |
| Installation | Automatically discover repositories when the app is installed. |
| Installation repositories | Automatically discover repositories added to or removed from an existing installation. |

Optional later events:

| Event | When to add it |
| --- | --- |
| Repository | Add when API Review Hub needs to react to repository rename, archive, transfer, or delete events. |

## Generate And Store The Private Key

After creating the app:

1. Open the new GitHub App settings.
2. Go to **Private keys**.
3. Select **Generate a private key**.
4. Download the `.pem` file.
5. Import the key into the Key Vault used by API Review Hub.
6. Delete the downloaded `.pem` file after the import is confirmed.

Example import command:

```powershell
az keyvault key import `
  --vault-name <key-vault-name> `
  --name api-review-hub `
  --pem-file <downloaded-private-key>.pem `
  --protection software
```

API Review Hub signs GitHub App JWTs through Key Vault cryptography. The resource access helper grants the app service managed identity secret access to the webhook secret and crypto access to this key:

```powershell
npm --prefix tools/api-review-hub run infra:grant-resource-access
```

## Configure API Review Hub

Update the API Review Hub infrastructure variables so App Configuration points at this app instead of `azure-sdk-automation`:

```yaml
GITHUB_APP_ID: <new-github-app-id>
GITHUB_APP_KEYVAULT_URL: "https://<key-vault-name>.vault.azure.net/"
GITHUB_APP_KEY_NAME: "api-review-hub"
```

Repository installability is controlled by the GitHub App registration. Use `Any account` so the app can be installed on the Azure SDK language repositories.
The app must also be public before accounts outside `azure-sdk-engineering-system` can install it.

Bootstrap App Configuration after changing the variables:

```powershell
npm --prefix tools/api-review-hub run infra:bootstrap-appconfig
```

## Install The App

Install the app on the account or organization that owns the repository API Review Hub should access. For a personal fork, install it on your personal GitHub account and select only that fork.

For a personal fork:

1. Get your GitHub account ID:

  ```powershell
  gh api user --jq .id
  ```

2. Open the app install URL with that account ID:

  ```text
  https://github.com/apps/api-review-hub/installations/new?target_id=<your-user-id>
  ```

3. Confirm the page says it is installing on your personal account, not `azure-sdk-engineering-system`.
4. Select **Only select repositories**.
5. Select your fork repository.
6. Confirm GitHub shows the requested permissions and webhook events before approving installation.

For Azure SDK organization repositories, install the app on the approved target organization and select only the repositories needed for the workflow. Prefer selected repositories over all repositories unless the engineering system owners approve all-repository installation.

