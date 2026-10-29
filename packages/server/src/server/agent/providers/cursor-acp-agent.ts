import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zSessionConfigOption } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentLaunchContext,
  AgentModelDefinition,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  deriveSelectorOptions,
  type ACPCatalogModelResolverContext,
  type ACPConfigFeatureOption,
  type ACPSessionLaunchPreparation,
  type ACPToolSnapshot,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  roleCapsuleRoot?: string;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};
const CURSOR_ROLE_UNATTENDED_ARGS = [
  "--force",
  "--approve-mcps",
  "--trust",
  "--sandbox",
  "disabled",
] as const;
const CURSOR_ROLE_READ_ONLY_ARGS = ["--mode", "plan", "--trust", "--sandbox", "enabled"] as const;

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

export function isCursorOpaqueMcpToolSnapshot(snapshot: ACPToolSnapshot): boolean {
  if (snapshot.kind != null && snapshot.kind !== "other") {
    return false;
  }
  const title = snapshot.title.trim().toLowerCase();
  if (title === "mcp: tool") {
    return true;
  }
  if (snapshot.title.trim() !== snapshot.toolCallId.trim()) {
    return false;
  }
  if (snapshot.rawInput !== undefined && snapshot.rawInput !== null) {
    return false;
  }
  return (
    snapshot.rawOutput != null &&
    typeof snapshot.rawOutput === "object" &&
    !Array.isArray(snapshot.rawOutput) &&
    Object.keys(snapshot.rawOutput).length === 1 &&
    (snapshot.rawOutput as Record<string, unknown>).success === true
  );
}

export function markCursorOpaqueMcpToolSnapshot(snapshot: ACPToolSnapshot): ACPToolSnapshot {
  return {
    ...snapshot,
    transportShadow: isCursorOpaqueMcpToolSnapshot(snapshot) ? "cursor-opaque-mcp" : undefined,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roleCapsuleCommand(
  command: readonly [string, ...string[]],
  capsuleDirectory: string,
  cwd: string,
  readOnly: boolean,
): [string, ...string[]] {
  const acpIndexes = command.flatMap((argument, index) => (argument === "acp" ? [index] : []));
  const hasCallerWorkspace = command.some(
    (argument) => argument === "--workspace" || argument.startsWith("--workspace="),
  );
  const hasCallerPermissionPolicy = command.some(
    (argument) =>
      argument === "-f" ||
      argument === "--force" ||
      argument === "--yolo" ||
      argument === "--auto-review" ||
      argument === "--approve-mcps" ||
      argument === "--trust" ||
      argument === "--mode" ||
      argument.startsWith("--mode=") ||
      argument === "--sandbox" ||
      argument.startsWith("--sandbox="),
  );
  if (acpIndexes.length !== 1 || hasCallerWorkspace || hasCallerPermissionPolicy) {
    throw new Error(
      "Cursor role binding requires exact 'cursor-agent ... acp' launch without caller-supplied workspace or permission-policy flags",
    );
  }
  const acpIndex = acpIndexes[0];
  return [
    command[0],
    ...command.slice(1, acpIndex),
    ...(readOnly ? CURSOR_ROLE_READ_ONLY_ARGS : CURSOR_ROLE_UNATTENDED_ARGS),
    "--workspace",
    capsuleDirectory,
    "--add-dir",
    cwd,
    ...command.slice(acpIndex),
  ];
}

async function writeExclusiveOrVerify(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(`Cursor role capsule collision at '${path}'`, { cause: error });
    }
  }
}

export async function materializeCursorRoleCapsule(input: {
  command: readonly [string, ...string[]];
  cwd: string;
  launchContext: AgentLaunchContext;
  modeId?: string;
  capsuleRoot?: string;
}): Promise<ACPSessionLaunchPreparation> {
  const roleBinding = input.launchContext.roleBinding;
  if (!roleBinding) {
    throw new Error("Cursor role capsule materialization requires an immutable role binding");
  }
  if (!input.launchContext.agentId) {
    throw new Error("Cursor role capsule materialization requires a stable Paseo agent ID");
  }

  const agentToken = sha256(input.launchContext.agentId).slice(0, 12);
  const bindingToken = sha256(roleBinding.instructions).slice(0, 12);
  const capsuleRoot = input.capsuleRoot ?? join(homedir(), ".paseo", "role-capsules", "cursor");
  const directory = join(capsuleRoot, `paseo-${roleBinding.roleId}-${agentToken}-${bindingToken}`);
  const rulesDirectory = join(directory, ".cursor", "rules");
  const rulePath = join(rulesDirectory, "paseo-role.mdc");
  const content = `---\ndescription: Bind the immutable Paseo ${roleBinding.roleId} contract\nalwaysApply: true\n---\n\n${roleBinding.instructions}\n`;

  await mkdir(rulesDirectory, { recursive: true, mode: 0o700 });
  await writeExclusiveOrVerify(rulePath, content);
  return {
    command: roleCapsuleCommand(input.command, directory, input.cwd, input.modeId === "plan"),
    featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: input.modeId !== "plan" },
  };
}

const CursorModelCatalogSchema = z.object({
  models: z.array(
    z.object({
      value: z.string().min(1),
      name: z.string(),
      configOptions: z.array(zSessionConfigOption),
    }),
  ),
});

// Cursor model switches persist CLI preferences, even in a throwaway probe session.
// Its extension returns each model's parameter definitions without selecting it.
export async function resolveCursorCatalogModels({
  connection,
  models,
  provider,
  runRequest,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  const catalog = await runRequest(() => fetchCursorModelCatalog(connection));
  const currentModelId = models.find((model) => model.isDefault)?.id;

  return catalog.models.map((model) => {
    const thinkingOptions = deriveSelectorOptions(model.configOptions, "thought_level");
    const defaultThinkingOptionId = thinkingOptions.find((option) => option.isDefault)?.id;
    return {
      provider,
      id: model.value,
      label: model.name,
      isDefault: model.value === currentModelId,
      thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
      defaultThinkingOptionId,
    };
  });
}

async function fetchCursorModelCatalog(connection: ACPCatalogModelResolverContext["connection"]) {
  try {
    const response = await connection.extMethod("cursor/list_available_models", {});
    return CursorModelCatalogSchema.parse(response);
  } catch (error) {
    const extensionUnavailable =
      typeof error === "object" && error !== null && "code" in error && error.code === -32601;
    if (extensionUnavailable) {
      throw new Error(
        "Update Cursor CLI: this version does not support cursor/list_available_models.",
        { cause: error },
      );
    }
    throw error;
  }
}

export class CursorACPAgentClient extends GenericACPAgentClient {
  private readonly roleCommand: [string, ...string[]];
  private readonly roleCapsuleRoot?: string;

  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      usageProvider: "cursor",
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
      catalogModelResolver: resolveCursorCatalogModels,
      // Cursor ACP intentionally redacts MCP tool identity as `MCP: tool` (or
      // omits the title) with empty input and `{ success: true }` output. Keep
      // the canonical transport event for audit, mark it, and let projection
      // collapse it only when an adjacent authoritative Paseo receipt exists.
      toolSnapshotTransformer: markCursorOpaqueMcpToolSnapshot,
    });
    this.roleCommand = options.command;
    this.roleCapsuleRoot = options.roleCapsuleRoot;
  }

  protected override async prepareSessionLaunch(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<ACPSessionLaunchPreparation | undefined> {
    if (!launchContext?.roleBinding) {
      return super.prepareSessionLaunch(config, launchContext);
    }
    return materializeCursorRoleCapsule({
      command: this.roleCommand,
      cwd: config.cwd,
      launchContext,
      modeId: config.modeId,
      capsuleRoot: this.roleCapsuleRoot,
    });
  }
}
