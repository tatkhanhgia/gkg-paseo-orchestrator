import type { Command } from "commander";
import {
  withOutput,
  type CommandError,
  type ListResult,
  type OutputSchema,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import type { HubDaemonConnection, HubStatus } from "./daemon-client.js";
import { withHubDaemon } from "./daemon-client.js";
import { reportHubProgress, type HubReporter } from "./reporter.js";
import { hubStatusResult } from "./status-output.js";

interface HubPermissionsOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  json?: boolean;
}

interface HubPermissionsDependencies {
  daemon: HubDaemonConnection;
  reporter: HubReporter;
  env?: Readonly<Record<string, string | undefined>>;
}

interface PermissionRow {
  permission: string;
  description: string;
}

const schema: OutputSchema<PermissionRow> = {
  idField: "permission",
  columns: [
    { header: "PERMISSION", field: "permission" },
    { header: "DESCRIPTION", field: "description" },
  ],
};

export function runHubPermissionsList(
  options: HubPermissionsOptions,
  dependencies: HubPermissionsDependencies,
): Promise<ListResult<PermissionRow>> {
  return withHubDaemon(dependencies.daemon, options.daemonTarget, async (client) => {
    const status = (await client.getHubStatus()).status;
    requireConnectedHub(status);
    return {
      type: "list",
      data: status.permissions.map((permission) => ({
        permission,
        description: describePermission(permission),
      })),
      schema,
    };
  });
}

export async function runHubPermissionChange(
  operation: "grant" | "revoke",
  permission: string,
  options: HubPermissionsOptions,
  dependencies: HubPermissionsDependencies,
) {
  assertHubPermissionChangeHumanContext(dependencies.env);
  return await withHubDaemon(dependencies.daemon, options.daemonTarget, async (client) => {
    const current = (await client.getHubStatus()).status;
    requireConnectedHub(current);
    const response = await client.updateHubPermissions(
      operation === "grant" ? { grant: [permission] } : { revoke: [permission] },
    );
    reportHubProgress(
      dependencies.reporter,
      options,
      `${operation === "grant" ? "Granted" : "Revoked"} ${permission} ${
        operation === "grant" ? "to" : "from"
      } ${response.status.hubOrigin}`,
    );
    return hubStatusResult(response.status);
  });
}

export function assertHubPermissionChangeHumanContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const callerAgentId = env.PASEO_AGENT_ID?.trim();
  if (!callerAgentId) return;
  throw {
    code: "HUB_PERMISSION_CHANGE_HUMAN_REQUIRED",
    message: "Hub authority changes are Human-owned. Paseo agents cannot grant or revoke them.",
    details: `Caller agent: ${callerAgentId}`,
  } satisfies CommandError;
}

export function addHubPermissionsCommand(
  parent: Command,
  dependencies: HubPermissionsDependencies,
): void {
  const permissions = parent
    .command("permissions")
    .description("Manage this Hub's daemon permissions");

  addJsonAndDaemonHostOptions(permissions.command("list")).action(
    withOutput(async (...args) => {
      const options = args.at(-2) as HubPermissionsOptions;
      return runHubPermissionsList(options, dependencies);
    }),
  );

  for (const operation of ["grant", "revoke"] as const) {
    addJsonAndDaemonHostOptions(
      permissions.command(operation).argument("<permission>", "Daemon permission"),
    ).action(
      withOutput(async (...args) => {
        const permission = args[0] as string;
        const options = args.at(-2) as HubPermissionsOptions;
        return runHubPermissionChange(operation, permission, options, dependencies);
      }),
    );
  }
}

function requireConnectedHub(status: HubStatus): void {
  if (
    status.hubOrigin === null ||
    (status.state !== "connected" && status.state !== "reconnecting")
  ) {
    throw new Error("This daemon is not connected to a Hub");
  }
}

function describePermission(permission: string): string {
  return permission === "hub.execute" ? "Run agents for Hub automations" : permission;
}
