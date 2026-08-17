import type { Logger } from "pino";

import type { AgentLaunchContext, AgentSessionConfig } from "../agent-sdk-types.js";
import { isExactGrokACPCommand } from "../role-binding.js";
import { type ACPSessionLaunchPreparation } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

export const GROK_ROLE_SUBAGENTS_ENV = {
  GROK_SUBAGENTS: "0",
} as const;

export function grokRoleLaunchCommand(
  command: readonly [string, ...string[]],
): [string, ...string[]] {
  if (!isExactGrokACPCommand(command)) {
    throw new Error(
      "Grok role binding requires exact 'grok agent stdio' launch without caller-supplied profile, plugin, or extra flags",
    );
  }
  return [command[0], "agent", "--no-leader", "stdio"];
}

export function materializeGrokRoleSessionLaunch(input: {
  command: readonly [string, ...string[]];
  launchContext: AgentLaunchContext;
}): ACPSessionLaunchPreparation {
  const roleBinding = input.launchContext.roleBinding;
  if (!roleBinding) {
    throw new Error("Grok role session materialization requires an immutable role binding");
  }
  return {
    command: grokRoleLaunchCommand(input.command),
    env: { ...GROK_ROLE_SUBAGENTS_ENV },
    sessionMeta: { rules: roleBinding.instructions },
  };
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  private readonly roleCommand: [string, ...string[]];

  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
    });
    this.roleCommand = options.command;
  }

  protected override async prepareSessionLaunch(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<ACPSessionLaunchPreparation | undefined> {
    if (!launchContext?.roleBinding) {
      return super.prepareSessionLaunch(config, launchContext);
    }
    return materializeGrokRoleSessionLaunch({
      command: this.roleCommand,
      launchContext,
    });
  }
}
