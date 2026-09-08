import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentPermissionRequestKind } from "../../../agent/agent-sdk-types.js";
import type { AgentManagerEvent, ManagedAgent } from "../../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../../agent/agent-storage.js";
import { resolveCoordinationSignal } from "../../../agent/coordination-signals.js";
import { startEventPolicyRuntime } from "../../../agent/event-policy-runtime.js";
import {
  SLP_LIFECYCLE_ATTENTION_DISABLE_FLAG,
  SLP_LIFECYCLE_ATTENTION_EVENT_POLICY,
  slpLifecycleAttentionPolicyEnabled,
} from "./lifecycle-attention-policy.js";

const TEST_STATE_NAMESPACE = "slp@test-generation";

function roleBinding(roleId: "lead" | "peer" | "supervisor") {
  return {
    policyOwner: {
      kind: "plugin" as const,
      pluginId: "slp",
      generationDigest: "a".repeat(64),
      policyVersion: "test",
    },
    roleId,
    definitionVersion: "test",
    definitionDigest: "definition",
    bindingDigest: `binding-${roleId}`,
    provider: "codex",
    injectionMethod: "codex-developer-instructions" as const,
    qualification: "implementation-supported" as const,
    workspaceProtocol: { status: "missing" as const, path: "/repo/WORKSPACE_PROTOCOL.md" },
    createdAt: new Date().toISOString(),
    instructions: `Role: ${roleId}`,
  };
}

function createHarness() {
  const records = new Map<string, StoredAgentRecord>();
  const agents = new Map<string, ManagedAgent>();
  const subscribers = new Set<{
    callback: (event: AgentManagerEvent) => void;
    agentId?: string;
  }>();
  const sent: Array<{ agentId: string; message: string }> = [];

  function addAgent(input: {
    id: string;
    roleId: "lead" | "peer" | "supervisor";
    lifecycle?: "idle" | "running" | "error" | "closed";
    parentAgentId?: string;
    internal?: boolean;
    activeTurnId?: string | null;
    activeTurnStartedAt?: Date | null;
  }) {
    const binding = roleBinding(input.roleId);
    const labels = input.parentAgentId ? { "paseo.parent-agent-id": input.parentAgentId } : {};
    const lifecycle = input.lifecycle ?? "idle";
    agents.set(input.id, {
      id: input.id,
      provider: "codex",
      cwd: "/repo",
      workspaceId: "workspace-1",
      roleBinding: binding,
      labels,
      lifecycle,
      internal: input.internal ?? false,
      activeTurnId: input.activeTurnId ?? null,
      activeTurnStartedAt: input.activeTurnStartedAt ?? null,
      pendingPermissions: new Map(),
    } as ManagedAgent);
    records.set(input.id, {
      id: input.id,
      provider: "codex",
      cwd: "/repo",
      workspaceId: "workspace-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      labels,
      lastStatus: lifecycle,
      config: null,
      persistence: null,
      roleBinding: binding,
    });
  }

  const dependencies = {
    agentStorage: {
      get: vi.fn(async (id: string) => records.get(id) ?? null),
      list: vi.fn(async () => [...records.values()]),
      upsert: vi.fn(async (record: StoredAgentRecord) => records.set(record.id, record)),
    },
    agentManager: {
      getAgent: vi.fn((id: string) => agents.get(id) ?? null),
      listAgents: vi.fn(() => [...agents.values()]),
      hasInFlightRun: vi.fn((id: string) => agents.get(id)?.lifecycle === "running"),
      notifyAgentAttention: vi.fn(),
      notifyAgentState: vi.fn(),
      subscribe: vi.fn(
        (
          callback: (event: AgentManagerEvent) => void,
          options?: { agentId?: string; replayState?: boolean },
        ) => {
          const subscription = { callback, agentId: options?.agentId };
          subscribers.add(subscription);
          return () => subscribers.delete(subscription);
        },
      ),
    },
    sendAtSafeBoundary: vi.fn(async (agentId: string, message: string) => {
      if (agents.get(agentId)?.lifecycle === "running") throw new Error("unsafe delivery");
      sent.push({ agentId, message });
    }),
    logger: pino({ level: "silent" }),
  };

  function eventAgentId(event: AgentManagerEvent): string | undefined {
    if (event.type === "agent_stream") return event.agentId;
    if (event.type === "agent_state") return event.agent.id;
    if (event.type === "agent_closure") return event.agentId;
    return undefined;
  }

  function applyPendingPermissionSideEffect(event: AgentManagerEvent) {
    if (event.type !== "agent_stream") return;
    const agent = agents.get(event.agentId);
    if (!agent) return;
    if (event.event.type === "permission_requested") {
      agent.pendingPermissions.set(event.event.request.id, event.event.request);
    } else if (event.event.type === "permission_resolved") {
      agent.pendingPermissions.delete(event.event.requestId);
    }
  }

  function emit(event: AgentManagerEvent) {
    // Mirror AgentManager's own bookkeeping so a policy reading `agent.pendingPermissions`
    // via getAgent() sees the same live state a real daemon would present.
    applyPendingPermissionSideEffect(event);
    for (const subscription of subscribers) {
      if (!subscription.agentId || subscription.agentId === eventAgentId(event)) {
        subscription.callback(event);
      }
    }
  }

  const start = () =>
    startEventPolicyRuntime({
      dependencies,
      advertisedPolicies: [SLP_LIFECYCLE_ATTENTION_EVENT_POLICY],
      resolvePolicies: () => [
        { policy: SLP_LIFECYCLE_ATTENTION_EVENT_POLICY, stateNamespace: TEST_STATE_NAMESPACE },
      ],
      environment: {},
    });

  return { addAgent, agents, dependencies, emit, records, start };
}

function permissionRequestedEvent(input: {
  agentId: string;
  requestId: string;
  kind?: AgentPermissionRequestKind;
}): Extract<AgentManagerEvent, { type: "agent_stream" }> {
  return {
    type: "agent_stream",
    agentId: input.agentId,
    event: {
      type: "permission_requested",
      provider: "codex",
      request: {
        id: input.requestId,
        provider: "codex",
        name: "run_command",
        kind: input.kind ?? "tool",
        title: "Permission required",
      },
    },
  };
}

function permissionResolvedEvent(input: {
  agentId: string;
  requestId: string;
}): Extract<AgentManagerEvent, { type: "agent_stream" }> {
  return {
    type: "agent_stream",
    agentId: input.agentId,
    event: {
      type: "permission_resolved",
      provider: "codex",
      requestId: input.requestId,
      resolution: { behavior: "allow" },
    },
  };
}

function usageEvent(agentId: string): Extract<AgentManagerEvent, { type: "agent_stream" }> {
  return {
    type: "agent_stream",
    agentId,
    event: {
      type: "usage_updated",
      provider: "codex",
      usage: { contextWindowUsedTokens: 1, contextWindowMaxTokens: 100 },
    },
  };
}

describe("bundled SLP lifecycle attention policy", () => {
  test("is enabled by default with an exact emergency disable", () => {
    expect(slpLifecycleAttentionPolicyEnabled({})).toBe(true);
    expect(
      slpLifecycleAttentionPolicyEnabled({ [SLP_LIFECYCLE_ATTENTION_DISABLE_FLAG]: "0" }),
    ).toBe(true);
    expect(
      slpLifecycleAttentionPolicyEnabled({ [SLP_LIFECYCLE_ATTENTION_DISABLE_FLAG]: "1" }),
    ).toBe(false);
  });

  test("preserves a legitimate wait: a permission resolved quickly never raises attention", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();

    harness.emit(permissionRequestedEvent({ agentId: "peer-1", requestId: "req-1" }));
    harness.emit(permissionResolvedEvent({ agentId: "peer-1", requestId: "req-1" }));
    harness.emit(usageEvent("peer-1"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("lead-1")?.coordinationSignals).toBeUndefined();
    runtime.stop();
  });

  test("escalates only once a still-pending permission crosses the wait threshold on a later event", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();
    const dateSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    dateSpy.mockImplementation(() => now);

    harness.emit(permissionRequestedEvent({ agentId: "peer-1", requestId: "req-1" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.records.get("lead-1")?.coordinationSignals).toBeUndefined();

    now += 120_001;
    harness.emit(usageEvent("peer-1"));
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1),
    );
    const signal = harness.records.get("lead-1")?.coordinationSignals?.[0];
    expect(signal).toMatchObject({
      recipientRole: "lead",
      relatedAgentId: "peer-1",
      customEvent: "slp.pending_permission_wait",
      source: { kind: "paseo", ruleId: "pending_permission_wait" },
      evidence: { requestId: "req-1" },
    });

    // Dedupe: further events while still pending do not raise a second signal.
    now += 1_000;
    harness.emit(usageEvent("peer-1"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1);

    dateSpy.mockRestore();
    runtime.stop();
  });

  test("re-arms with a fresh request id after resolution", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();
    const dateSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    dateSpy.mockImplementation(() => now);

    harness.emit(permissionRequestedEvent({ agentId: "peer-1", requestId: "req-1" }));
    // The durable requestedAt write from the permission_requested event is dispatched
    // asynchronously; without waiting for it to land before advancing the mocked clock, the
    // write can observe the already-advanced `now` and never register as stale.
    await new Promise((resolve) => setTimeout(resolve, 5));
    now += 120_001;
    harness.emit(usageEvent("peer-1"));
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1),
    );
    const first = harness.records.get("lead-1")?.coordinationSignals?.[0];
    if (!first) throw new Error("missing first signal");
    await resolveCoordinationSignal(harness.dependencies, {
      targetAgentId: "lead-1",
      signalId: first.id,
      resolution: "completed",
    });
    harness.emit(permissionResolvedEvent({ agentId: "peer-1", requestId: "req-1" }));

    harness.emit(permissionRequestedEvent({ agentId: "peer-1", requestId: "req-2" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    now += 120_001;
    harness.emit(usageEvent("peer-1"));
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(2),
    );
    const second = harness.records.get("lead-1")?.coordinationSignals?.[1];
    expect(second?.id).not.toBe(first.id);
    expect(second).toMatchObject({ evidence: { requestId: "req-2" } });

    dateSpy.mockRestore();
    runtime.stop();
  });

  test("signals a captured started run cleared by real closure evidence", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();

    harness.emit({
      type: "agent_closure",
      agentId: "peer-1",
      cause: "agent closed",
      lifecycleBeforeClose: "running",
      policyOwner: {
        kind: "plugin",
        pluginId: "slp",
        generationDigest: "a".repeat(64),
        policyVersion: "test",
      },
      run: {
        kind: "foreground",
        turnId: "turn-9",
        startedAt: "2026-09-06T00:00:00.000Z",
      },
      internal: false,
    });

    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1),
    );
    expect(harness.records.get("lead-1")?.coordinationSignals?.[0]).toMatchObject({
      customEvent: "slp.lost_run",
      relatedAgentId: "peer-1",
      source: { ruleId: "lost_run_on_closure" },
      evidence: {
        cause: "agent closed",
        lifecycleBeforeClose: "running",
        runKind: "foreground",
        turnId: "turn-9",
      },
    });
    runtime.stop();
  });

  test("preserves normal close and incomplete/fake closure negatives", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();
    const peerAgent = harness.dependencies.agentManager.getAgent("peer-1");
    if (!peerAgent) throw new Error("missing peer agent");

    harness.emit({
      type: "agent_state",
      agent: {
        ...peerAgent,
        lifecycle: "closed",
        activeTurnId: "turn-9",
        activeTurnStartedAt: new Date(),
      } as ManagedAgent,
    });
    harness.emit({
      type: "agent_closure",
      agentId: "peer-1",
      cause: "agent closed",
      lifecycleBeforeClose: "idle",
      policyOwner: {
        kind: "plugin",
        pluginId: "slp",
        generationDigest: "a".repeat(64),
        policyVersion: "test",
      },
      run: null,
      internal: false,
    });
    harness.emit({
      type: "agent_closure",
      agentId: "peer-1",
      cause: "agent reloaded",
      lifecycleBeforeClose: "running",
      policyOwner: {
        kind: "plugin",
        pluginId: "slp",
        generationDigest: "a".repeat(64),
        policyVersion: "test",
      },
      run: { kind: "foreground", turnId: "turn-10", startedAt: null },
      internal: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("lead-1")?.coordinationSignals).toBeUndefined();
    runtime.stop();
  });
});
