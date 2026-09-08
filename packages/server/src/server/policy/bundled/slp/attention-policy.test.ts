import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentManagerEvent, ManagedAgent } from "../../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../../agent/agent-storage.js";
import { resolveCoordinationSignal } from "../../../agent/coordination-signals.js";
import { startEventPolicyRuntime } from "../../../agent/event-policy-runtime.js";
import {
  classifySemanticFriction,
  SLP_ATTENTION_DISABLE_FLAG,
  SLP_ATTENTION_EVENT_POLICY,
  slpAttentionPolicyEnabled,
} from "./attention-policy.js";

const TEST_STATE_NAMESPACE = "slp@test-generation";
const TEST_STATE_KEY = `${TEST_STATE_NAMESPACE}/slp.attention`;

function roleBinding(roleId: "lead" | "peer" | "supervisor") {
  return {
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
    lifecycle?: "idle" | "running" | "error";
    parentAgentId?: string;
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
      internal: false,
      activeTurnId: null,
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

  function removeAgent(id: string) {
    agents.delete(id);
    records.delete(id);
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
    return undefined;
  }

  function emit(event: AgentManagerEvent) {
    for (const subscription of subscribers) {
      if (!subscription.agentId || subscription.agentId === eventAgentId(event)) {
        subscription.callback(event);
      }
    }
  }

  const start = () =>
    startEventPolicyRuntime({
      dependencies,
      advertisedPolicies: [SLP_ATTENTION_EVENT_POLICY],
      resolvePolicies: () => [
        { policy: SLP_ATTENTION_EVENT_POLICY, stateNamespace: TEST_STATE_NAMESPACE },
      ],
      environment: {},
    });

  return { addAgent, dependencies, emit, records, removeAgent, sent, start };
}

describe("bundled SLP attention policy", () => {
  test("is enabled by default with an exact emergency disable", () => {
    expect(slpAttentionPolicyEnabled({})).toBe(true);
    expect(slpAttentionPolicyEnabled({ [SLP_ATTENTION_DISABLE_FLAG]: "0" })).toBe(true);
    expect(slpAttentionPolicyEnabled({ [SLP_ATTENTION_DISABLE_FLAG]: "1" })).toBe(false);
  });

  test("classifies sparse semantic friction and ignores ordinary output", () => {
    expect(classifySemanticFriction("Hold on, I overlooked the ownership contract.")).toMatchObject(
      {
        ruleId: "admitted_mistake",
      },
    );
    expect(
      classifySemanticFriction("The focused tests passed and the candidate is ready."),
    ).toBeNull();
  });

  test("classifies bilingual Vietnamese semantic friction and ignores ordinary Vietnamese output", () => {
    expect(classifySemanticFriction("Khoan đã, ranh giới thẩm quyền chưa rõ ràng.")).toMatchObject({
      ruleId: "explicit_reconsideration",
    });
    expect(classifySemanticFriction("Tôi đã sai về phạm vi của thay đổi này.")).toMatchObject({
      ruleId: "admitted_mistake",
    });
    expect(
      classifySemanticFriction("Việc này mâu thuẫn với thẩm quyền hiện tại của Lead."),
    ).toMatchObject({
      ruleId: "contract_conflict",
    });
    expect(classifySemanticFriction("Tôi đang bị chặn và cần làm rõ phạm vi.")).toMatchObject({
      ruleId: "blocked_uncertainty",
    });
    expect(classifySemanticFriction("Các bài kiểm tra đã qua và ứng viên đã sẵn sàng.")).toBeNull();
  });

  test("does not classify a trigger phrase that is only quoted, reported, or cited as test data", () => {
    // Exact regression fixture: a trigger phrase cited as test/fixture data is not the model's
    // own live admission and must never trigger.
    expect(
      classifySemanticFriction('The fixture contains the string "I was wrong" as test data.'),
    ).toBeNull();
    expect(
      classifySemanticFriction(
        'The reviewer wrote: "Hold on, I made a mistake about the scope." before continuing.',
      ),
    ).toBeNull();
    expect(
      classifySemanticFriction(
        'The test asserts that classifySemanticFriction reports "I overlooked the contract" as a match.',
      ),
    ).toBeNull();
    expect(
      classifySemanticFriction('Tài liệu kiểm thử chứa chuỗi "tôi đã sai" làm dữ liệu mẫu.'),
    ).toBeNull();
    expect(
      classifySemanticFriction(
        'Người review viết rằng: "tôi đã sai về phạm vi" trước khi tiếp tục.',
      ),
    ).toBeNull();
  });

  test("still classifies genuine unquoted first-person self-admission, English and Vietnamese", () => {
    expect(
      classifySemanticFriction("Hold on, I was wrong about the ownership boundary."),
    ).toMatchObject({ ruleId: "admitted_mistake" });
    expect(
      classifySemanticFriction("Tôi đã sai về ranh giới thẩm quyền, cần xem lại ngay."),
    ).toMatchObject({ ruleId: "admitted_mistake" });
    // Quoting alone does not suppress a match: only a preceding citation/report lead-in does.
    // Here the quote opens the sentence, so there is nothing before it to cite from.
    const match = classifySemanticFriction('"I was wrong," I admitted, and moved on.');
    expect(match).toMatchObject({ ruleId: "admitted_mistake" });
  });

  test("skips a cited fixture occurrence but retains a later live admission", () => {
    const english =
      'The fixture contains the string "I was wrong" as test data. The neutral sentence is deliberately long enough to separate the cited fixture from the live assistant statement by more than the citation window. I was wrong about the ownership boundary.';
    const vietnamese =
      'Tài liệu kiểm thử chứa chuỗi "tôi đã sai" làm dữ liệu mẫu. Câu trung tính này đủ dài để tách dữ liệu được trích dẫn khỏi lời tự nhận thật sự của trợ lý trong cùng một lượt. Tôi đã sai về ranh giới thẩm quyền.';

    expect(classifySemanticFriction(english)).toMatchObject({ ruleId: "admitted_mistake" });
    expect(classifySemanticFriction(vietnamese)).toMatchObject({ ruleId: "admitted_mistake" });
  });

  test("re-arms context pressure after a below-threshold transition and resolution", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    const runtime = harness.start();
    const usage = (used: number) =>
      harness.emit({
        type: "agent_stream",
        agentId: "lead-1",
        event: {
          type: "usage_updated",
          provider: "codex",
          usage: { contextWindowUsedTokens: used, contextWindowMaxTokens: 100 },
        },
      });

    usage(90);
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
    usage(40);
    usage(90);
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(2),
    );
    runtime.stop();
  });

  test("treats contradictory over-maximum context telemetry as unknown", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    const runtime = harness.start();
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: {
        type: "usage_updated",
        provider: "codex",
        usage: { contextWindowUsedTokens: 120, contextWindowMaxTokens: 100 },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("lead-1")?.coordinationSignals).toBeUndefined();
    runtime.stop();
  });

  test("coalesces pending compactions and re-arms after disposition", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    const runtime = harness.start();
    const compaction = {
      type: "agent_stream" as const,
      agentId: "lead-1",
      event: {
        type: "timeline" as const,
        provider: "claude",
        item: {
          type: "compaction" as const,
          status: "completed" as const,
          trigger: "auto" as const,
        },
      },
    };
    harness.emit(compaction);
    harness.emit(compaction);
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1),
    );
    const first = harness.records.get("lead-1")?.coordinationSignals?.[0];
    if (!first) throw new Error("missing first signal");
    await resolveCoordinationSignal(harness.dependencies, {
      targetAgentId: "lead-1",
      signalId: first.id,
      resolution: "deferred",
    });
    harness.emit(compaction);
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(2),
    );
    expect(
      harness.records.get("lead-1")?.eventPolicyStates?.[TEST_STATE_KEY]?.state
        .automaticCompactionCount,
    ).toBe(3);
    runtime.stop();
  });

  test("namespaces durable state by exact generation and policy", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    const record = harness.records.get("lead-1");
    if (!record) throw new Error("missing Lead record");
    const runtime = harness.start();
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "compaction", status: "completed", trigger: "auto" },
      },
    });
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.eventPolicyStates?.[TEST_STATE_KEY]).toMatchObject({
        version: 5,
        state: { automaticCompactionCount: 1, consecutiveTurnFailures: 0 },
      }),
    );
    expect(harness.records.get("lead-1")?.eventPolicyStates?.["slp.attention"]).toBeUndefined();
    runtime.stop();
  });

  test("routes semantic friction from visible Lead output to one unique Supervisor", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "supervisor-1", roleId: "supervisor" });
    const runtime = harness.start();
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "Hold on, I overlooked the authority boundary." },
      },
    });
    await vi.waitFor(() =>
      expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(1),
    );
    expect(harness.records.get("supervisor-1")?.coordinationSignals?.[0]).toMatchObject({
      recipientRole: "supervisor",
      relatedAgentId: "lead-1",
      customEvent: "slp.semantic_friction",
      source: { kind: "paseo", ruleId: "semantic_friction:admitted_mistake" },
      evidence: { classifierRule: "admitted_mistake" },
    });
    const first = harness.records.get("supervisor-1")?.coordinationSignals?.[0];
    if (!first) throw new Error("missing first semantic attention signal");
    await resolveCoordinationSignal(harness.dependencies, {
      targetAgentId: "supervisor-1",
      signalId: first.id,
      resolution: "completed",
    });
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
    });
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-2",
        item: { type: "assistant_message", text: "On second thought, I missed the scope." },
      },
    });
    await vi.waitFor(() =>
      expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(2),
    );
    runtime.stop();
  });

  test("does not buffer semantic fragments before a unique Supervisor exists", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    const runtime = harness.start();
    const emitVisible = (text: string) =>
      harness.emit({
        type: "agent_stream",
        agentId: "lead-1",
        event: {
          type: "timeline",
          provider: "codex",
          turnId: "turn-1",
          item: { type: "assistant_message", text },
        },
      });

    emitVisible("I made a ");
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.addAgent({ id: "supervisor-1", roleId: "supervisor" });
    emitVisible("mistake about the authority boundary.");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("supervisor-1")?.coordinationSignals).toBeUndefined();
    runtime.stop();
  });

  test("clears semantic fragments while the Supervisor target is ambiguous", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "supervisor-1", roleId: "supervisor" });
    harness.addAgent({ id: "supervisor-2", roleId: "supervisor" });
    const runtime = harness.start();
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "I made a " },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.removeAgent("supervisor-2");
    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "assistant_message",
          text: "mistake about the authority boundary.",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("supervisor-1")?.coordinationSignals).toBeUndefined();
    runtime.stop();
  });

  test("fails closed for ambiguous Supervisor targets and never classifies reasoning", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "peer-1", roleId: "peer" });
    harness.addAgent({ id: "supervisor-1", roleId: "supervisor" });
    harness.addAgent({ id: "supervisor-2", roleId: "supervisor" });
    const runtime = harness.start();
    harness.emit({
      type: "agent_stream",
      agentId: "peer-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "reasoning", text: "Hold on, I made a mistake." },
      },
    });
    harness.emit({
      type: "agent_stream",
      agentId: "peer-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "Hold on, I made a mistake." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("supervisor-1")?.coordinationSignals).toBeUndefined();
    expect(harness.records.get("supervisor-2")?.coordinationSignals).toBeUndefined();
    runtime.stop();
  });

  test.each(["acknowledged", "deferred", "declined", "completed"] as const)(
    "re-arms a semantic fingerprint after %s while coalescing only the pending episode",
    async (resolution) => {
      const harness = createHarness();
      harness.addAgent({ id: "lead-1", roleId: "lead" });
      harness.addAgent({ id: "supervisor-1", roleId: "supervisor", lifecycle: "running" });
      const runtime = harness.start();
      const emitVisible = (text: string) =>
        harness.emit({
          type: "agent_stream",
          agentId: "lead-1",
          event: {
            type: "timeline",
            provider: "codex",
            turnId: "turn-1",
            item: { type: "assistant_message", text },
          },
        });

      emitVisible("I made a mistake about the scope.");
      await vi.waitFor(() =>
        expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(1),
      );
      emitVisible("I made a mistake about the scope.");
      await vi.waitFor(() =>
        expect(harness.records.get("supervisor-1")?.coordinationSignals?.[0]?.occurrenceCount).toBe(
          2,
        ),
      );
      const first = harness.records.get("supervisor-1")?.coordinationSignals?.[0];
      if (!first) throw new Error("missing semantic signal");
      await resolveCoordinationSignal(harness.dependencies, {
        targetAgentId: "supervisor-1",
        signalId: first.id,
        resolution,
      });
      emitVisible("I made a mistake about the scope.");
      await vi.waitFor(() =>
        expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(2),
      );
      const rearmed = harness.records.get("supervisor-1")?.coordinationSignals?.[1];
      expect(rearmed).toMatchObject({ status: "pending", occurrenceCount: 1 });
      expect(rearmed?.id).not.toBe(first.id);
      emitVisible("I made a mistake about the scope.");
      await vi.waitFor(() =>
        expect(harness.records.get("supervisor-1")?.coordinationSignals?.[1]?.occurrenceCount).toBe(
          2,
        ),
      );
      expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(2);

      emitVisible("This conflicts with the ownership contract.");
      await vi.waitFor(() =>
        expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(3),
      );
      expect(harness.records.get("supervisor-1")?.coordinationSignals?.[2]).toMatchObject({
        status: "pending",
        source: { kind: "paseo", ruleId: "semantic_friction:contract_conflict" },
      });
      runtime.stop();
    },
  );

  test("routes a fresh repeated-failure episode after a completed turn", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();
    const failure = {
      type: "agent_stream" as const,
      agentId: "peer-1",
      event: { type: "turn_failed" as const, provider: "codex", error: "provider failed" },
    };
    harness.emit(failure);
    harness.emit(failure);
    harness.emit(failure);
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1),
    );
    harness.emit({
      type: "agent_stream",
      agentId: "peer-1",
      event: { type: "turn_completed", provider: "codex" },
    });
    const first = harness.records.get("lead-1")?.coordinationSignals?.[0];
    if (!first) throw new Error("missing first signal");
    await resolveCoordinationSignal(harness.dependencies, {
      targetAgentId: "lead-1",
      signalId: first.id,
      resolution: "declined",
    });
    harness.emit(failure);
    harness.emit(failure);
    harness.emit(failure);
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(2),
    );
    runtime.stop();
  });

  test("notifies Human once for a Lead failure episode without a unique Supervisor", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    const runtime = harness.start();
    const failure = {
      type: "agent_stream" as const,
      agentId: "lead-1",
      event: { type: "turn_failed" as const, provider: "codex", error: "provider failed" },
    };

    harness.emit(failure);
    harness.emit(failure);
    harness.emit(failure);
    await vi.waitFor(() =>
      expect(harness.dependencies.agentManager.notifyAgentAttention).toHaveBeenCalledTimes(1),
    );
    expect(harness.dependencies.agentManager.notifyAgentAttention).toHaveBeenCalledWith(
      "lead-1",
      "error",
      "coordination",
    );

    harness.emit(failure);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.dependencies.agentManager.notifyAgentAttention).toHaveBeenCalledTimes(1);

    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: { type: "turn_completed", provider: "codex" },
    });
    harness.emit(failure);
    harness.emit(failure);
    harness.emit(failure);
    await vi.waitFor(() =>
      expect(harness.dependencies.agentManager.notifyAgentAttention).toHaveBeenCalledTimes(2),
    );

    harness.emit({
      type: "agent_stream",
      agentId: "lead-1",
      event: { type: "turn_canceled", provider: "codex" },
    });
    harness.emit(failure);
    harness.emit(failure);
    harness.emit(failure);
    await vi.waitFor(() =>
      expect(harness.dependencies.agentManager.notifyAgentAttention).toHaveBeenCalledTimes(3),
    );
    runtime.stop();
  });

  test("keeps the Lead coordination signal and skips Human notification with one Supervisor", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "supervisor-1", roleId: "supervisor" });
    const runtime = harness.start();
    const failure = {
      type: "agent_stream" as const,
      agentId: "lead-1",
      event: { type: "turn_failed" as const, provider: "codex", error: "provider failed" },
    };

    harness.emit(failure);
    harness.emit(failure);
    harness.emit(failure);
    await vi.waitFor(() =>
      expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(1),
    );
    expect(harness.dependencies.agentManager.notifyAgentAttention).not.toHaveBeenCalled();

    harness.emit(failure);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.records.get("supervisor-1")?.coordinationSignals).toHaveLength(1);
    expect(harness.dependencies.agentManager.notifyAgentAttention).not.toHaveBeenCalled();
    runtime.stop();
  });

  test("counts realistic interleaved turn starts and failures", async () => {
    const harness = createHarness();
    harness.addAgent({ id: "lead-1", roleId: "lead" });
    harness.addAgent({ id: "peer-1", roleId: "peer", parentAgentId: "lead-1" });
    const runtime = harness.start();
    for (let index = 1; index <= 3; index += 1) {
      harness.emit({
        type: "agent_stream",
        agentId: "peer-1",
        event: { type: "turn_started", provider: "codex", turnId: `turn-${index}` },
      });
      harness.emit({
        type: "agent_stream",
        agentId: "peer-1",
        event: {
          type: "turn_failed",
          provider: "codex",
          turnId: `turn-${index}`,
          error: "provider failed",
        },
      });
    }
    await vi.waitFor(() =>
      expect(harness.records.get("lead-1")?.coordinationSignals).toHaveLength(1),
    );
    expect(
      harness.records.get("peer-1")?.eventPolicyStates?.[TEST_STATE_KEY]?.state
        .consecutiveTurnFailures,
    ).toBe(3);
    runtime.stop();
  });
});
