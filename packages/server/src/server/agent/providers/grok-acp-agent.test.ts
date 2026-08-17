import { describe, expect, test } from "vitest";

import type { AgentLaunchContext, AgentSessionConfig } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { withACPSessionMeta } from "./acp-agent.js";
import {
  grokRoleLaunchCommand,
  GROK_ROLE_SUBAGENTS_ENV,
  GrokACPAgentClient,
  materializeGrokRoleSessionLaunch,
} from "./grok-acp-agent.js";

describe("Grok native role binding", () => {
  test("pins exact role bytes, isolated process, and native-subagent lock", () => {
    const prepared = materializeGrokRoleSessionLaunch({
      command: ["grok", "agent", "stdio"],
      launchContext: {
        agentId: "agent-1",
        roleBinding: {
          roleId: "peer",
          instructions: "Immutable Peer instructions",
        },
      },
    });

    expect(prepared).toEqual({
      command: ["grok", "agent", "--no-leader", "stdio"],
      env: { GROK_SUBAGENTS: "0" },
      sessionMeta: { rules: "Immutable Peer instructions" },
    });
    expect(GROK_ROLE_SUBAGENTS_ENV).toEqual({ GROK_SUBAGENTS: "0" });
    expect(prepared.env).toEqual(GROK_ROLE_SUBAGENTS_ENV);
  });

  test("accepts a command that already pins --no-leader", () => {
    expect(grokRoleLaunchCommand(["/opt/grok/bin/grok", "agent", "--no-leader", "stdio"])).toEqual([
      "/opt/grok/bin/grok",
      "agent",
      "--no-leader",
      "stdio",
    ]);
  });

  test("rejects caller-supplied Grok profile or plugin flags", () => {
    expect(() =>
      grokRoleLaunchCommand(["grok", "agent", "--plugin-dir", "/tmp/plugin", "stdio"]),
    ).toThrow("exact 'grok agent stdio'");
    expect(() =>
      grokRoleLaunchCommand(["grok", "agent", "--agent-profile", "/tmp/profile.json", "stdio"]),
    ).toThrow("exact 'grok agent stdio'");
  });

  test("requires an immutable role binding", () => {
    expect(() =>
      materializeGrokRoleSessionLaunch({
        command: ["grok", "agent", "stdio"],
        launchContext: { agentId: "agent-1" },
      }),
    ).toThrow("requires an immutable role binding");
  });

  test("attaches session rules on create and resume ACP params", () => {
    const sessionMeta = { rules: "Immutable Lead instructions" };
    expect(
      withACPSessionMeta(
        {
          cwd: "/workspace/repo",
          mcpServers: [],
        },
        sessionMeta,
      ),
    ).toEqual({
      cwd: "/workspace/repo",
      mcpServers: [],
      _meta: { rules: "Immutable Lead instructions" },
    });
    expect(
      withACPSessionMeta(
        {
          sessionId: "session-1",
          cwd: "/workspace/repo",
          mcpServers: [],
        },
        sessionMeta,
      ),
    ).toEqual({
      sessionId: "session-1",
      cwd: "/workspace/repo",
      mcpServers: [],
      _meta: { rules: "Immutable Lead instructions" },
    });
    expect(
      withACPSessionMeta({
        cwd: "/workspace/repo",
        mcpServers: [],
      }),
    ).toEqual({
      cwd: "/workspace/repo",
      mcpServers: [],
    });
  });

  test("role-bound prepareSessionLaunch materializes Grok session rules", async () => {
    class InspectableGrokACPAgentClient extends GrokACPAgentClient {
      inspectLaunch(config: AgentSessionConfig, launchContext?: AgentLaunchContext) {
        return this.prepareSessionLaunch(config, launchContext);
      }
    }
    const client = new InspectableGrokACPAgentClient({
      logger: createTestLogger(),
      command: ["grok", "agent", "stdio"],
      providerId: "grok",
      label: "Grok",
    });

    await expect(
      client.inspectLaunch(
        { provider: "acp", cwd: "/workspace/repo" },
        {
          agentId: "agent-1",
          roleBinding: {
            roleId: "lead",
            instructions: "Immutable Lead instructions",
          },
        },
      ),
    ).resolves.toEqual({
      command: ["grok", "agent", "--no-leader", "stdio"],
      env: { GROK_SUBAGENTS: "0" },
      sessionMeta: { rules: "Immutable Lead instructions" },
    });
    await expect(
      client.inspectLaunch({ provider: "acp", cwd: "/workspace/repo" }),
    ).resolves.toBeUndefined();
  });
});
