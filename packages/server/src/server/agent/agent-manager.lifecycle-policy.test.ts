import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentPermissionRequest,
  AgentPermissionResponse,
  ProviderLaunchBinding,
} from "./agent-sdk-types.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import { createDefaultSlpBundledPolicyRegistry } from "../policy/bundled/slp.js";
import { SLP_LIFECYCLE_ATTENTION_EVENT_POLICY } from "../policy/bundled/slp/lifecycle-attention-policy.js";
import { startEventPolicyRuntime } from "./event-policy-runtime.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsNativePaseoTools: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function assignment(
  role: "lead" | "peer",
  effectClass: AssignmentEnvelope["effectClass"],
): AssignmentEnvelope {
  return {
    version: 1,
    disposition: role === "lead" ? "lead-direct" : "peer-execution",
    objective: "Exercise the real AgentManager closure policy path.",
    effectClass,
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary:
      role === "lead" && effectClass !== "read-only"
        ? {
            mode: "bounded",
            scope:
              "Beads Central issue/work graph for this assignment only; no other external effects",
          }
        : { mode: "denied" },
    evidence: "Return the exact manager and policy evidence.",
    handbackAndStop: "Stop after the bounded lifecycle receipt.",
  };
}

class HeldSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  private currentTurnId: string | null = null;

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const turnId = `held-turn-${++this.turnCounter}`;
    this.currentTurnId = turnId;
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: "gpt-5.4", modeId: null };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId) return;
    this.currentTurnId = null;
    for (const subscriber of this.subscribers) {
      subscriber({
        type: "turn_canceled",
        provider: this.provider,
        reason: "interrupted",
        turnId,
      });
    }
  }

  async close(): Promise<void> {}
}

class HeldClient implements AgentClient {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    _config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new HeldSession();
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new HeldSession();
  }

  async materializeProviderLaunchBinding(input: {
    config: AgentSessionConfig;
    requestedModel?: string;
  }): Promise<ProviderLaunchBinding> {
    return {
      providerId: this.provider,
      providerFamily: this.provider,
      model: input.requestedModel ?? input.config.model ?? "gpt-5.4",
      credentialConfigured: true,
      routeKind: "codex-subscription",
      modelProviderId: "openai",
      authMethod: "codex-native",
    };
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      modes: [],
    };
  }
}

describe("AgentManager to SLP lifecycle policy integration", () => {
  test("captures a real started run before closure and rejects ordinary close/cancel as loss", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "paseo-lifecycle-policy-manager-"));
    const logger = pino({ level: "silent" });
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    await storage.initialize();
    writeFileSync(
      join(workdir, "WORKSPACE_PROTOCOL.md"),
      buildWorkspaceProtocolTemplate(workdir),
      "utf8",
    );

    const registry = createDefaultSlpBundledPolicyRegistry();
    const manager = new AgentManager({
      clients: { codex: new HeldClient() },
      bundledPolicyPacks: registry,
      registry: storage,
      logger,
    });
    const closureEvents: Extract<AgentManagerEvent, { type: "agent_closure" }>[] = [];
    const closedSnapshots: Extract<AgentManagerEvent, { type: "agent_state" }>[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_closure") closureEvents.push(event);
        if (event.type === "agent_state" && event.agent.lifecycle === "closed") {
          closedSnapshots.push(event);
        }
      },
      { replayState: false },
    );
    const runtime = startEventPolicyRuntime({
      dependencies: {
        agentManager: manager,
        agentStorage: storage,
        sendAtSafeBoundary: async () => {},
        logger,
      },
      advertisedPolicies: [SLP_LIFECYCLE_ATTENTION_EVENT_POLICY],
      resolvePolicies: (agentId, event) =>
        manager.resolveBundledEventPoliciesForAgent(
          agentId,
          event.type === "agent_closure" ? event : undefined,
        ),
    });

    const leadId = "00000000-0000-4000-8000-000000000201";
    const childId = "00000000-0000-4000-8000-000000000202";
    const normalCloseId = "00000000-0000-4000-8000-000000000203";
    const cancelId = "00000000-0000-4000-8000-000000000204";
    try {
      await manager.createAgent({ provider: "codex", cwd: workdir, model: "gpt-5.4" }, leadId, {
        workspaceId: "workspace-1",
        roleId: "lead",
        assignment: assignment("lead", "delegation"),
      });
      await manager.createAgent({ provider: "codex", cwd: workdir, model: "gpt-5.4" }, childId, {
        workspaceId: "workspace-1",
        roleId: "peer",
        assignment: assignment("peer", "read-only"),
        labels: { [PARENT_AGENT_ID_LABEL]: leadId },
      });

      const childStream = await manager.startAuthorizedAgentStream(childId, "hold");
      await childStream.next();
      const running = manager.getAgent(childId);
      expect(running?.lifecycle).toBe("running");
      expect(running?.activeTurnId).toBe("held-turn-1");
      expect(running?.activeTurnStartedAt).toBeInstanceOf(Date);

      await manager.closeAgent(childId);
      const closure = closureEvents.find((event) => event.agentId === childId);
      expect(closure).toMatchObject({
        cause: "agent closed",
        lifecycleBeforeClose: "running",
        policyOwner: {
          kind: "plugin",
          pluginId: "slp",
        },
        run: {
          kind: "foreground",
          turnId: "held-turn-1",
          startedAt: expect.any(String),
        },
      });
      const closed = closedSnapshots.find((event) => event.agent.id === childId)?.agent;
      expect(closed).toMatchObject({
        lifecycle: "closed",
        activeForegroundTurnId: null,
        activeTurnId: null,
        activeTurnStartedAt: null,
      });
      await vi.waitFor(async () => {
        expect((await storage.get(leadId))?.coordinationSignals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              customEvent: "slp.lost_run",
              relatedAgentId: childId,
              source: expect.objectContaining({ kind: "paseo", ruleId: "lost_run_on_closure" }),
            }),
          ]),
        );
      });

      await manager.createAgent(
        { provider: "codex", cwd: workdir, model: "gpt-5.4" },
        normalCloseId,
        {
          workspaceId: "workspace-1",
          roleId: "peer",
          assignment: assignment("peer", "read-only"),
          labels: { [PARENT_AGENT_ID_LABEL]: leadId },
        },
      );
      await manager.closeAgent(normalCloseId);
      const ordinaryClose = closureEvents.find((event) => event.agentId === normalCloseId);
      expect(ordinaryClose?.run).toBeNull();

      await manager.createAgent({ provider: "codex", cwd: workdir, model: "gpt-5.4" }, cancelId, {
        workspaceId: "workspace-1",
        roleId: "peer",
        assignment: assignment("peer", "read-only"),
        labels: { [PARENT_AGENT_ID_LABEL]: leadId },
      });
      const canceledStream = await manager.startAuthorizedAgentStream(cancelId, "hold");
      await canceledStream.next();
      await expect(manager.cancelAgentRun(cancelId)).resolves.toMatchObject({ status: "settled" });
      expect(manager.getAgent(cancelId)?.lifecycle).toBe("idle");
      await manager.closeAgent(cancelId);
      const ordinaryCancel = closureEvents.find((event) => event.agentId === cancelId);
      expect(ordinaryCancel?.run).toBeNull();

      const leadRecord = await storage.get(leadId);
      expect(leadRecord?.coordinationSignals).toHaveLength(1);
    } finally {
      unsubscribe();
      await manager.closeAgent(cancelId).catch(() => undefined);
      await manager.closeAgent(normalCloseId).catch(() => undefined);
      await manager.closeAgent(childId).catch(() => undefined);
      await manager.closeAgent(leadId).catch(() => undefined);
      await runtime.stop();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
