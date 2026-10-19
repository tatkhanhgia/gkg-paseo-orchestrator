import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import { createProjectHarnessBindingService } from "../project/harness-binding-service.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import { resolvePluginRoleBindingSupport } from "./role-binding.js";

const PROVIDER = "plugin-role";
const INSTRUCTIONS = "# Peer\nexact role bytes\n";

type OpenInput = Extract<ProviderInput, { type: "session.open" }>;

// Advertises no permission.tool_policy, like the ACP adapter. `confirm` decides whether
// session.opened carries the digest the daemon sent.
function roleProvider(options: { declares: boolean; confirm: boolean }) {
  const opens: OpenInput[] = [];
  const closes: string[] = [];
  let listener: ((event: ProviderEvent) => void) | null = null;
  const capabilities = ["prompt.message", "session.persistence"];
  const connection: ProviderConnection = {
    version: 1,
    capabilities,
    async send(input) {
      if (input.type === "session.open") {
        opens.push(input);
        listener?.({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities,
          restoration: "core",
          cwd: input.config.cwd,
          ...(options.confirm && input.config.roleBinding
            ? { roleBindingDigest: input.config.roleBinding.bindingDigest }
            : {}),
        });
        listener?.({
          type: "session.ready",
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
      } else if (input.type === "session.close") {
        closes.push(input.sessionId);
        listener?.({ type: "session.closed", sessionId: input.sessionId });
        listener?.({ type: "request.completed", requestId: input.requestId });
      }
    },
    onEvent(next) {
      listener = next;
      return () => undefined;
    },
    async close() {},
  };
  const registration: ProviderRegistration = {
    id: PROVIDER,
    label: "Plugin role",
    ...(options.declares ? { roleBinding: { roleIds: ["peer", "lead"] as const } } : {}),
    connect: async () => connection,
  };
  const registry = new PluginAgentClientRegistry(createTestLogger());
  registry.replace([registration]);
  return { registry, client: registry.clients()[PROVIDER]!, opens, closes };
}

const roleLaunchContext = {
  roleBinding: { roleId: "peer" as const, instructions: INSTRUCTIONS, noWrite: false },
};

test("a role payload reaches only declaring plugins and must be confirmed by the provider", async () => {
  const declaring = roleProvider({ declares: true, confirm: true });
  await declaring.client.createSession({ provider: PROVIDER, cwd: "/work" }, roleLaunchContext);
  expect(declaring.opens[0]?.config.roleBinding).toEqual({
    roleId: "peer",
    instructions: INSTRUCTIONS,
    bindingDigest: createHash("sha256").update(INSTRUCTIONS).digest("hex"),
    noWrite: false,
  });

  const plain = roleProvider({ declares: false, confirm: true });
  await expect(
    plain.client.createSession({ provider: PROVIDER, cwd: "/work" }, roleLaunchContext),
  ).rejects.toThrow("declares no role launch hook");
  expect(plain.opens).toHaveLength(0);

  const unconfirmed = roleProvider({ declares: true, confirm: false });
  await expect(
    unconfirmed.client.createSession({ provider: PROVIDER, cwd: "/work" }, roleLaunchContext),
  ).rejects.toThrow("did not confirm the role binding digest");
  expect(unconfirmed.closes).toEqual([unconfirmed.opens[0]!.sessionId]);
});

test("a Peer opens on a plugin provider without negotiating permission.tool_policy", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "plugin-role-peer-"));
  writeFileSync(join(workdir, "WORKSPACE_PROTOCOL.md"), buildWorkspaceProtocolTemplate(workdir));
  const { registry, opens } = roleProvider({ declares: true, confirm: true });
  const definition = registry.definitions()[PROVIDER]!;
  const manager = new AgentManager({
    clients: registry.clients(),
    providerDefinitions: {
      [PROVIDER]: {
        enabled: true,
        supportsExactMcpPreapproval: definition.supportsExactMcpPreapproval,
        roleBindingSupport: resolvePluginRoleBindingSupport({ roleIds: ["peer", "lead"] }),
      },
    },
    registry: new AgentStorage(join(workdir, "agents"), createTestLogger()),
    resolveHarnessBinding: createProjectHarnessBindingService({
      workspaceRegistry: {
        get: async (workspaceId) =>
          ({ workspaceId, projectId: "project-test", cwd: workdir, archivedAt: null }) as never,
      },
      projectRegistry: {
        get: async (projectId) => ({ projectId, rootPath: workdir, archivedAt: null }) as never,
        list: async () =>
          [{ projectId: "project-test", rootPath: workdir, archivedAt: null }] as never,
      },
    }),
    verifyRoleResourceGrants: async () => undefined,
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    logger: createTestLogger(),
  });

  try {
    const agent = await manager.createAgent(
      { provider: PROVIDER, cwd: workdir, model: "plugin-model" },
      "00000000-0000-4000-8000-000000000301",
      {
        workspaceId: "workspace-plugin-role",
        roleId: "peer",
        assignment: {
          version: 1,
          disposition: "peer-execution",
          objective: "Implement the granted issue.",
          effectClass: "mutating",
          mutationBoundary: { mode: "bounded-write", scope: workdir },
          externalEffectBoundary: {
            mode: "bounded",
            scope:
              "Beads Central issue/work graph for this assignment only; no other external effects",
          },
          resourceGrants: { beadsIssueIds: ["ps-plugin-role"] },
          evidence: "Return exact changed scope and verification.",
          handbackAndStop: "Stop after the bounded implementation or a material blocker.",
        },
      },
    );

    expect(opens).toHaveLength(1);
    expect(opens[0]?.config.mcpServers.paseo).toMatchObject({
      type: "http",
      url: expect.stringContaining(`callerAgentId=${agent.id}`),
    });
    expect(opens[0]?.config.toolPolicy).toBeUndefined();
    expect(opens[0]?.config.roleBinding?.instructions).toBe(agent.roleBinding?.instructions);
    expect(opens[0]?.config.roleBinding?.noWrite).toBe(false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
