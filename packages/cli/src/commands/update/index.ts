import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

interface UpdateOptions extends CommandOptions {
  host?: string;
  tag?: string;
}

interface UpdateCommandResult {
  action: "check" | "prepare" | "apply" | "status" | "rollback";
  success: boolean;
  currentVersion?: string | null;
  version?: string | null;
  tag?: string | null;
  releaseUrl?: string | null;
  phase?: string | null;
  source?: "cache" | "network";
  checkedAt?: string;
  message?: string | null;
  error: string | null;
}

const updateSchema: OutputSchema<UpdateCommandResult> = {
  idField: (result) => result.version ?? result.action,
  columns: [],
  renderHuman(result) {
    if (result.type !== "single") return "";
    const value = result.data;
    if (value.action === "check") {
      if (value.error && !value.version) return `Update check failed: ${value.error}`;
      if (value.version) {
        return `Downstream update available: ${
          value.currentVersion ?? "unknown"
        } -> ${value.version}\n${value.releaseUrl ?? ""}`.trim();
      }
      return `Paseo ${value.currentVersion ?? "unknown"} is up to date.`;
    }
    if (value.action === "status") {
      return [
        `Update status: ${value.phase ?? "unknown"}`,
        value.version ? `Version: ${value.version}` : null,
        value.message,
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (!value.success) return `${value.action} failed: ${value.error ?? "unknown error"}`;
    if (value.action === "prepare") return `Prepared downstream update ${value.version}.`;
    if (value.action === "rollback") return `Rollback to ${value.version} was accepted.`;
    return `Update to ${value.version} was accepted. Paseo will reconnect after verification.`;
  },
};

async function withClient<T>(
  target: DaemonTarget,
  operation: (client: DaemonClient) => Promise<T>,
) {
  const client = await connectToDaemon({ target });
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

export async function runUpdateCheckCommand(
  options: UpdateOptions,
): Promise<SingleResult<UpdateCommandResult>> {
  const payload = await withClient(options.daemonTarget, (client) =>
    client.checkDistributionUpdate({ intent: "manual" }),
  );
  return {
    type: "single",
    data: {
      action: "check",
      success: payload.error === null,
      currentVersion: payload.currentVersion,
      version: payload.update?.version ?? null,
      tag: payload.update?.tag ?? null,
      releaseUrl: payload.update?.releaseUrl ?? null,
      source: payload.source,
      checkedAt: payload.checkedAt,
      error: payload.error,
    },
    schema: updateSchema,
  };
}

export async function runUpdatePrepareCommand(
  options: UpdateOptions,
): Promise<SingleResult<UpdateCommandResult>> {
  const payload = await withClient(options.daemonTarget, (client) =>
    client.prepareDistributionUpdate({ tag: options.tag }),
  );
  return {
    type: "single",
    data: {
      action: "prepare",
      success: payload.success,
      version: payload.version,
      error: payload.error,
    },
    schema: updateSchema,
  };
}

export async function runUpdateApplyCommand(
  options: UpdateOptions,
): Promise<SingleResult<UpdateCommandResult>> {
  const payload = await withClient(options.daemonTarget, (client) =>
    client.applyDistributionUpdate({ tag: options.tag }),
  );
  return {
    type: "single",
    data: {
      action: "apply",
      success: payload.accepted,
      version: payload.version,
      error: payload.error,
    },
    schema: updateSchema,
  };
}

export async function runUpdateStatusCommand(
  options: UpdateOptions,
): Promise<SingleResult<UpdateCommandResult>> {
  const payload = await withClient(options.daemonTarget, (client) =>
    client.getDistributionUpdateStatus(),
  );
  return {
    type: "single",
    data: {
      action: "status",
      success: payload.status.phase !== "failed",
      phase: payload.status.phase,
      version: payload.status.version,
      message: payload.status.message,
      error: payload.status.phase === "failed" ? payload.status.message : null,
    },
    schema: updateSchema,
  };
}

export async function runUpdateRollbackCommand(
  options: UpdateOptions,
): Promise<SingleResult<UpdateCommandResult>> {
  const payload = await withClient(options.daemonTarget, (client) =>
    client.rollbackDistributionUpdate(),
  );
  return {
    type: "single",
    data: {
      action: "rollback",
      success: payload.accepted,
      version: payload.version,
      error: payload.error,
    },
    schema: updateSchema,
  };
}

export function createUpdateCommand(): Command {
  const update = new Command("update").description("Update the downstream Paseo local stack");
  addJsonAndDaemonHostOptions(
    update.command("check").description("Check the downstream release"),
  ).action(
    withOutput((options: UpdateOptions, _command: Command) => runUpdateCheckCommand(options)),
  );
  addJsonAndDaemonHostOptions(
    update.command("prepare").description("Download and verify an update").option("--tag <tag>"),
  ).action(
    withOutput((options: UpdateOptions, _command: Command) => runUpdatePrepareCommand(options)),
  );
  addJsonAndDaemonHostOptions(
    update.command("apply").description("Prepare and apply an update").option("--tag <tag>"),
  ).action(
    withOutput((options: UpdateOptions, _command: Command) => runUpdateApplyCommand(options)),
  );
  addJsonAndDaemonHostOptions(
    update.command("status").description("Show update transaction status"),
  ).action(
    withOutput((options: UpdateOptions, _command: Command) => runUpdateStatusCommand(options)),
  );
  addJsonAndDaemonHostOptions(
    update.command("rollback").description("Reinstall the newest previous portable release"),
  ).action(
    withOutput((options: UpdateOptions, _command: Command) => runUpdateRollbackCommand(options)),
  );
  return update;
}
