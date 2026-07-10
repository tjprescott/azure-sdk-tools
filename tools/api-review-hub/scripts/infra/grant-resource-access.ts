import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadVariables } from "./variables.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "../..");

async function main(): Promise<void> {
    const variables = await loadVariables();
    const webAppPrincipalId = await getWebAppPrincipalId(variables.resourceGroupName, variables.webAppName, variables.subscriptionId);
    const appConfigurationId = await getAppConfigurationId(variables.resourceGroupName, variables.appConfigurationName, variables.subscriptionId);
    const keyVaultId = await getKeyVaultId(variables.keyVaultName, variables.subscriptionId);
    const githubAppKeyScope = `${keyVaultId}/keys/${variables.githubAppKeyName}`;

    await grantAzureRole(webAppPrincipalId, "ServicePrincipal", "App Configuration Data Reader", appConfigurationId);
    await grantAzureRole(webAppPrincipalId, "ServicePrincipal", "Key Vault Secrets Officer", keyVaultId);
    await grantAzureRole(webAppPrincipalId, "ServicePrincipal", "Key Vault Crypto User", githubAppKeyScope);

    if (variables.assigneeObjectId) {
        await grantAzureRole(variables.assigneeObjectId, "User", "App Configuration Data Owner", appConfigurationId);
        await grantAzureRole(variables.assigneeObjectId, "User", "Key Vault Secrets Officer", keyVaultId);
        await grantAzureRole(variables.assigneeObjectId, "User", "Key Vault Crypto Officer", keyVaultId);
    }

    console.log("Granted API Review Hub Azure RBAC resource access.");
}

async function getWebAppPrincipalId(resourceGroupName: string, webAppName: string, subscriptionId: string): Promise<string> {
    const principalId = await runAz([
        "webapp",
        "identity",
        "show",
        "--resource-group",
        resourceGroupName,
        "--name",
        webAppName,
        "--subscription",
        subscriptionId,
        "--query",
        "principalId",
        "-o",
        "tsv",
    ]);

    if (!principalId) {
        throw new Error(`Web app ${webAppName} does not have a system-assigned managed identity.`);
    }

    return principalId;
}

async function getAppConfigurationId(resourceGroupName: string, appConfigurationName: string, subscriptionId: string): Promise<string> {
    return runAz([
        "appconfig",
        "show",
        "--resource-group",
        resourceGroupName,
        "--name",
        appConfigurationName,
        "--subscription",
        subscriptionId,
        "--query",
        "id",
        "-o",
        "tsv",
    ]);
}

async function getKeyVaultId(keyVaultName: string, subscriptionId: string): Promise<string> {
    return runAz([
        "keyvault",
        "show",
        "--name",
        keyVaultName,
        "--subscription",
        subscriptionId,
        "--query",
        "id",
        "-o",
        "tsv",
    ]);
}

async function grantAzureRole(principalId: string, principalType: "ServicePrincipal" | "User", roleName: string, scope: string): Promise<void> {
    await runAz([
        "role",
        "assignment",
        "create",
        "--assignee-object-id",
        principalId,
        "--assignee-principal-type",
        principalType,
        "--role",
        roleName,
        "--scope",
        scope,
    ], true);
}

async function runAz(args: readonly string[], ignoreExistingRoleAssignment = false): Promise<string> {
    const command = process.platform === "win32" ? "az.cmd" : "az";
    console.log(`Running command: az ${args.join(" ")}`);

    return new Promise<string>((resolvePromise, reject) => {
        let stdout = "";
        let stderr = "";
        const child = process.platform === "win32"
            ? spawn([command, ...args].map(quoteWindowsShellArgument).join(" "), {
                cwd: packageDirectory,
                shell: true,
            })
            : spawn(command, args, {
                cwd: packageDirectory,
                shell: false,
            });

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (data: string) => {
            stdout += data;
        });
        child.stderr.on("data", (data: string) => {
            stderr += data;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolvePromise(stdout.trim());
                return;
            }

            if (ignoreExistingRoleAssignment && stderr.includes("RoleAssignmentExists")) {
                console.log("Role assignment already exists.");
                resolvePromise(stdout.trim());
                return;
            }

            reject(new Error(`Command failed with exit code ${code}: az ${args.join(" ")}\n${stderr}`));
        });
    });
}

function quoteWindowsShellArgument(argument: string): string {
    return /[\s"]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to grant API Review Hub resource access: ${message}`);
    process.exitCode = 1;
});
