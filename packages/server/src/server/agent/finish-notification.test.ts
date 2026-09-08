import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import type { AgentManagerEvent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  attachFinishNotificationWatch,
  cancelFinishNotificationWatch,
  registerFinishNotificationWatch,
  resumePendingFinishNotificationDeliveries,
  setupFinishNotification,
  type FinishNotificationDependencies,
} from "./finish-notification.js";
import type { FinishNotificationCouncilSeatLookup } from "../policy/bundled/slp/finish-notification-policy.js";

/**
 * `deliveredAt`/a successful send in every test below means dispatch was
 * acknowledged by the fake provider — it is NOT proof the caller process
 * executed the follow-up turn, read the content, or accepted its
 * disposition. See coordinated-delivery.ts's module doc comment for the
 * production contract this mirrors.
 */

type FakeLifecycle = "initializing" | "idle" | "running" | "error" | "closed";

interface FakeAgent {
  id: string;
  lifecycle: FakeLifecycle;
  activeForegroundTurnId: string | null;
  activeTurnStartedAt: Date | null;
  pendingPermissions: Map<string, unknown>;
}

function makeFakeAgent(id: string, lifecycle: FakeLifecycle = "idle"): FakeAgent {
  return {
    id,
    lifecycle,
    activeForegroundTurnId: null,
    activeTurnStartedAt: lifecycle === "running" ? new Date("2026-09-06T00:00:00.000Z") : null,
    pendingPermissions: new Map(),
  };
}

function makeRecord(id: string, overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: "/repo",
    workspaceId: "workspace-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: {},
    lastStatus: "idle",
    config: null,
    persistence: null,
    title: "Child Agent",
    ...overrides,
  } as StoredAgentRecord;
}

function createFinishHarness() {
  const agents = new Map<string, FakeAgent>();
  const records = new Map<string, StoredAgentRecord>();
  const subscribers = new Set<{ agentId: string | null; cb: (event: AgentManagerEvent) => void }>();
  const sentPrompts: Array<{ agentId: string; prompt: string; via: "start" | "replace" }> = [];
  const lastAssistantMessages = new Map<string, string | null>();
  const sendFailures = new Map<string, number>();
  let runStartFailure: Error | null = null;
  let beforeProviderStart: (() => Promise<void>) | null = null;
  let notifyAgentStateCount = 0;

  function dispatch(event: AgentManagerEvent): void {
    for (const sub of subscribers) {
      if (sub.agentId === null) {
        sub.cb(event);
        continue;
      }
      const eventAgentId = event.type === "agent_state" ? event.agent.id : event.agentId;
      if (eventAgentId === sub.agentId) {
        sub.cb(event);
      }
    }
  }

  function setLifecycle(
    agentId: string,
    lifecycle: FakeLifecycle,
    turnId: string | null = null,
  ): void {
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`unknown fake agent ${agentId}`);
    agent.lifecycle = lifecycle;
    agent.activeForegroundTurnId = lifecycle === "running" ? turnId : null;
    agent.activeTurnStartedAt =
      lifecycle === "running" ? new Date("2026-09-06T00:00:00.000Z") : null;
    dispatch({ type: "agent_state", agent: { ...agent } as never });
  }

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (id: string) => agents.get(id) ?? null);
  Reflect.set(
    agentManager,
    "subscribe",
    (cb: (event: AgentManagerEvent) => void, options?: { agentId?: string }) => {
      const sub = { agentId: options?.agentId ?? null, cb };
      subscribers.add(sub);
      return () => subscribers.delete(sub);
    },
  );
  Reflect.set(
    agentManager,
    "hasInFlightRun",
    (id: string) => agents.get(id)?.lifecycle === "running",
  );
  Reflect.set(agentManager, "waitForAgentRunStart", async () => {
    if (runStartFailure) throw runStartFailure;
  });
  Reflect.set(agentManager, "notifyAgentState", (id: string) => {
    notifyAgentStateCount += 1;
    const agent = agents.get(id);
    if (agent) dispatch({ type: "agent_state", agent: { ...agent } as never });
  });
  Reflect.set(
    agentManager,
    "getLastAssistantMessage",
    async (id: string) => lastAssistantMessages.get(id) ?? null,
  );
  Reflect.set(agentManager, "tryRunOutOfBandAuthorized", async () => false);
  Reflect.set(agentManager, "steerOrReplaceActiveTurnAuthorized", async () => ({
    status: "inactive",
  }));
  Reflect.set(
    agentManager,
    "startAuthorizedAgentStream",
    async (agentId: string, prompt: string) => {
      const remaining = sendFailures.get(agentId) ?? 0;
      if (remaining > 0) {
        sendFailures.set(agentId, remaining - 1);
        throw new Error("transient provider send failure");
      }
      if (beforeProviderStart) {
        await beforeProviderStart();
      }
      if (!runStartFailure) {
        sentPrompts.push({ agentId, prompt, via: "start" });
      }
      return (async function* () {})();
    },
  );
  Reflect.set(agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    sentPrompts.push({ agentId, prompt, via: "replace" });
    return (async function* () {})();
  });
  Reflect.set(agentManager, "setAgentMode", async () => {});

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (id: string) => records.get(id) ?? null);
  Reflect.set(agentStorage, "upsert", async (record: StoredAgentRecord) => {
    records.set(record.id, record);
  });
  Reflect.set(agentStorage, "list", async () => Array.from(records.values()));

  return {
    agents,
    records,
    sentPrompts,
    lastAssistantMessages,
    sendFailures,
    setRunStartFailure(error: Error | null) {
      runStartFailure = error;
    },
    setBeforeProviderStart(callback: (() => Promise<void>) | null) {
      beforeProviderStart = callback;
    },
    get notifyAgentStateCount() {
      return notifyAgentStateCount;
    },
    agentManager,
    agentStorage,
    setLifecycle,
    createDependencies(
      resolveCouncilSeatProjection?: FinishNotificationDependencies["resolveCouncilSeatProjection"],
    ): FinishNotificationDependencies {
      return {
        agentManager,
        agentStorage,
        logger: createTestLogger(),
        resolveCouncilSeatProjection,
      };
    },
  };
}

test("unchanged observed-run persistence is bounded when notifyAgentState re-enters subscribers", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  const notificationsAfterRegistration = h.notifyAgentStateCount;
  const stop = attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });

  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches).toEqual([
      expect.objectContaining({
        watchId: watch.watchId,
        observedRunId: "turn-1",
        observedRunStartedAt: "2026-09-06T00:00:00.000Z",
      }),
    ]);
  });
  expect(h.notifyAgentStateCount).toBe(notificationsAfterRegistration + 1);
  stop();
});

test("registers the durable watch before any launch/attach observation", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "initializing"));
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const watch = await registerFinishNotificationWatch(h.createDependencies(), {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });

  const persisted = await h.agentStorage.get("child-1");
  expect(persisted?.finishNotificationWatches).toEqual([
    expect.objectContaining({
      watchId: watch.watchId,
      callerAgentId: "caller-1",
      status: "active",
    }),
  ]);
  expect(h.sentPrompts).toEqual([]);
});

test("cancelFinishNotificationWatch stops a watch whose initial run never started", async () => {
  const h = createFinishHarness();
  h.records.set("child-1", makeRecord("child-1"));

  const watch = await registerFinishNotificationWatch(h.createDependencies(), {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  await cancelFinishNotificationWatch(h.createDependencies(), { childAgentId: "child-1", watch });

  const persisted = await h.agentStorage.get("child-1");
  expect(persisted?.finishNotificationWatches).toEqual([
    expect.objectContaining({ watchId: watch.watchId, status: "stopped" }),
  ]);
});

test("does not synthesize a finish from a prelaunch idle snapshot", async () => {
  const h = createFinishHarness();
  // No durable started-run receipt exists. An idle snapshot cannot distinguish a
  // prelaunch crash from a fast finish and must remain unknown.
  h.agents.set("child-1", makeFakeAgent("child-1", "idle"));
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));
  h.lastAssistantMessages.set("child-1", "Done.");

  const watch = await registerFinishNotificationWatch(h.createDependencies(), {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(h.createDependencies(), { childAgentId: "child-1", watch });

  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.sentPrompts).toEqual([]);
});

test("two independent watches on the same run collapse into exactly one delivery", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));

  // Simulates the Lead-reported bug: create.ts and paseo-tools.ts both watching
  // the same child/run for the same caller.
  const deps = h.createDependencies();
  const watchA = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch: watchA });
  const watchB = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch: watchB });

  h.setLifecycle("child-1", "idle");

  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.sentPrompts).toHaveLength(1);
  const deliveries = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries ?? [];
  expect(deliveries).toHaveLength(1);
});

test("a legitimate second run after completion notifies again with a distinct delivery", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watch1 = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch: watch1 });
  h.setLifecycle("child-1", "idle");
  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1));

  // A brand-new launch registers a fresh watch for the run that follows.
  const watch2 = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  h.setLifecycle("child-1", "running", "turn-2");
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch: watch2 });
  h.setLifecycle("child-1", "idle");

  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(2));
  const deliveries = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries ?? [];
  expect(deliveries).toHaveLength(2);
  expect(new Set(deliveries.map((d) => d.deliveryId)).size).toBe(2);
});

test("a transient send failure recovers via bounded in-process retry without any further agent_state event", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));
  h.sendFailures.set("caller-1", 1);

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");

  // No further agent_state event is ever dispatched for "caller-1" after this
  // point: recovery must come from the bounded in-process retry inside
  // coordinated-delivery.ts, not from waiting on a future idle transition.
  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1), { timeout: 3000, interval: 50 });
  const delivery = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0];
  expect(delivery?.deliveredAt).not.toBeNull();
});

test("a finish notification never replaces or steers the caller's active run", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.sentPrompts).toEqual([]);

  h.setLifecycle("caller-1", "idle");
  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1));
  expect(h.sentPrompts[0]?.via).toBe("start");
});

test("drops a pending notification when the caller assignment expires after registration", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h.records.set(
    "caller-1",
    makeRecord("caller-1", {
      roleBinding: {
        assignment: { expiresAt: "2099-01-01T00:00:00.000Z" },
        assignmentContract: { receipt: { expiresAt: "2099-01-01T00:00:00.000Z" } },
      } as never,
    }),
  );

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });

  const callerRecord = await h.agentStorage.get("caller-1");
  await h.agentStorage.upsert({
    ...callerRecord!,
    roleBinding: {
      ...callerRecord!.roleBinding,
      assignment: { expiresAt: "2020-01-01T00:00:00.000Z" },
      assignmentContract: { receipt: { expiresAt: "2020-01-01T00:00:00.000Z" } },
    } as never,
  });
  h.setLifecycle("caller-1", "idle");

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.sentPrompts).toEqual([]);
  expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0]).toEqual(
    expect.objectContaining({
      deliveredAt: null,
      droppedAt: expect.any(String),
      dropReason: "caller-assignment-expired-at-dispatch",
    }),
  );
});

test("retries when provider error text says assignment expired but the caller remains current", async () => {
  vi.useFakeTimers();
  try {
    const h = createFinishHarness();
    h.agents.set("child-1", makeFakeAgent("child-1", "running"));
    h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
    h.records.set("child-1", makeRecord("child-1"));
    h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
    h.records.set(
      "caller-1",
      makeRecord("caller-1", {
        roleBinding: {
          assignment: { expiresAt: "2099-01-01T00:00:00.000Z" },
          assignmentContract: { receipt: { expiresAt: "2099-01-01T00:00:00.000Z" } },
        } as never,
      }),
    );
    const errorMessage = "assignment_contract_expired: expiresAt=2099-01-01T00:00:00.000Z";
    h.setRunStartFailure(new Error(errorMessage));

    const deps = h.createDependencies();
    const watch = await registerFinishNotificationWatch(deps, {
      childAgentId: "child-1",
      callerAgentId: "caller-1",
    });
    attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
    h.setLifecycle("child-1", "idle");

    await vi.waitFor(async () => {
      const delivery = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0];
      expect(delivery?.attempts).toBe(1);
      expect(delivery?.lastError).toBe(errorMessage);
    });
    const delivery = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0];
    expect(delivery?.deliveredAt ?? null).toBeNull();
    expect(delivery?.droppedAt ?? null).toBeNull();
    expect(h.sentPrompts).toEqual([]);

    // Prevent the bounded retry timer from dispatching again while the assertion is complete.
    h.agents.get("caller-1")!.lifecycle = "running";
    await vi.advanceTimersByTimeAsync(500);
  } finally {
    vi.useRealTimers();
  }
});

test("drops only when a fresh canonical assignment is expired at the shared start boundary", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set(
    "caller-1",
    makeRecord("caller-1", {
      roleBinding: {
        assignment: { expiresAt: "2099-01-01T00:00:00.000Z" },
        assignmentContract: { receipt: { expiresAt: "2099-01-01T00:00:00.000Z" } },
      } as never,
    }),
  );
  h.setRunStartFailure(
    new Error("assignment_contract_expired: expiresAt=2020-01-01T00:00:00.000Z"),
  );
  h.setBeforeProviderStart(async () => {
    const callerRecord = await h.agentStorage.get("caller-1");
    await h.agentStorage.upsert({
      ...callerRecord!,
      roleBinding: {
        ...callerRecord!.roleBinding,
        assignment: { expiresAt: "2020-01-01T00:00:00.000Z" },
        assignmentContract: { receipt: { expiresAt: "2020-01-01T00:00:00.000Z" } },
      } as never,
    });
  });

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");

  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0]).toEqual(
      expect.objectContaining({
        deliveredAt: null,
        droppedAt: expect.any(String),
        dropReason: "caller-assignment-expired-at-start",
        attempts: 0,
      }),
    );
  });
  expect(h.sentPrompts).toEqual([]);
});

test("parent ownership is re-checked freshly at delivery time, not registration time", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set(
    "child-1",
    makeRecord("child-1", { labels: { "paseo.parent-agent-id": "caller-1" } }),
  );
  h.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
    requireParentOwnership: true,
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });

  // Detach happens before the caller ever goes idle and before delivery runs.
  const childRecord = await h.agentStorage.get("child-1");
  await h.agentStorage.upsert({ ...childRecord!, labels: {} });

  h.setLifecycle("caller-1", "idle");
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(h.sentPrompts).toEqual([]);
  const delivery = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0];
  // Dropped means the stale attribution is terminal; it is not a delivery receipt.
  expect(delivery?.deliveredAt).toBeNull();
  expect(delivery?.droppedAt).not.toBeNull();
});

test("drops pending notifications when the caller becomes archived before delivery", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });

  const callerRecord = await h.agentStorage.get("caller-1");
  await h.agentStorage.upsert({ ...callerRecord!, archivedAt: "2024-01-01T00:00:00.000Z" });
  h.setLifecycle("caller-1", "idle");

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.sentPrompts).toEqual([]);
  const delivery = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0];
  expect(delivery?.deliveredAt).toBeNull();
  expect(delivery?.droppedAt).not.toBeNull();
});

test("a sealed council seat yields receipt-only content, never the child's message", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));
  h.lastAssistantMessages.set("child-1", "SECRET UNAUDITED CONTENT");

  const resolveCouncilSeatProjection = async (): Promise<FinishNotificationCouncilSeatLookup> => ({
    status: "found",
    seat: {
      caseId: "case-1",
      seatId: "seat-1",
      phase: "sealed",
      terminal: true,
      receiptPointer: "receipt-1",
    },
  });

  const deps = h.createDependencies(resolveCouncilSeatProjection);
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");

  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1));
  expect(h.sentPrompts[0]?.prompt).not.toContain("SECRET UNAUDITED CONTENT");
  expect(h.sentPrompts[0]?.prompt).toContain("case-1");
  expect(h.sentPrompts[0]?.prompt).toContain("seat-1");
});

test("resumePendingFinishNotificationDeliveries redelivers an undelivered notification after a restart", async () => {
  const h1 = createFinishHarness();
  h1.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h1.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h1.records.set("child-1", makeRecord("child-1"));
  h1.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h1.records.set("caller-1", makeRecord("caller-1"));

  const deps1 = h1.createDependencies();
  const watch = await registerFinishNotificationWatch(deps1, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps1, { childAgentId: "child-1", watch });
  h1.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h1.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });
  expect(h1.sentPrompts).toEqual([]);

  // Simulate a daemon restart: fresh in-process AgentManager/AgentStorage
  // instances, but the same persisted records survive.
  const h2 = createFinishHarness();
  for (const [id, record] of h1.records) h2.records.set(id, record);
  h2.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));

  const stop = await resumePendingFinishNotificationDeliveries(h2.createDependencies());
  await vi.waitFor(() => expect(h2.sentPrompts).toHaveLength(1));
  stop();
});

test("resumePendingFinishNotificationDeliveries reconciles a watch registered but never attached before a crash", async () => {
  const h1 = createFinishHarness();
  h1.records.set("child-1", makeRecord("child-1"));
  h1.records.set("caller-1", makeRecord("caller-1"));

  // Durable intent recorded before launch; the daemon crashes before any
  // started-run receipt exists. Restart must not invent a finished run.
  await registerFinishNotificationWatch(h1.createDependencies(), {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });

  const h2 = createFinishHarness();
  for (const [id, record] of h1.records) h2.records.set(id, record);
  h2.agents.set("child-1", makeFakeAgent("child-1", "idle"));
  h2.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));

  const stop = await resumePendingFinishNotificationDeliveries(h2.createDependencies());
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h2.sentPrompts).toEqual([]);
  stop();
});

test("a persisted active watch with an observed run receipt survives resume against a lazy-bootstrap manager that has not loaded the child yet", async () => {
  const h1 = createFinishHarness();
  h1.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h1.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h1.records.set("child-1", makeRecord("child-1"));
  h1.records.set("caller-1", makeRecord("caller-1"));

  const deps1 = h1.createDependencies();
  const watch = await registerFinishNotificationWatch(deps1, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  // Observe the run starting (durable receipt persisted) but crash before any
  // terminal event — the exact window F1 covers.
  attachFinishNotificationWatch(deps1, { childAgentId: "child-1", watch });
  await vi.waitFor(async () => {
    expect(
      (await h1.agentStorage.get("child-1"))?.finishNotificationWatches?.[0]?.observedRunId,
    ).toBe("turn-1");
  });

  // Restart with fresh manager/storage instances that mirror bootstrap's
  // lazy loading: the persisted record exists, but the child is NOT yet in
  // the in-memory AgentManager (`h2.agents` has no entry for it), so
  // `getAgent("child-1")` returns null exactly like the real bootstrap
  // precondition this bug reproduces.
  const h2 = createFinishHarness();
  for (const [id, record] of h1.records) h2.records.set(id, record);
  h2.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));

  const stop = await resumePendingFinishNotificationDeliveries(h2.createDependencies());
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The watch must remain the durable, unresolved intent it was before
  // restart — not fabricated into "stopped" merely because the manager has
  // not lazily loaded the child yet.
  expect((await h2.agentStorage.get("child-1"))?.finishNotificationWatches).toEqual([
    expect.objectContaining({ watchId: watch.watchId, status: "active", observedRunId: "turn-1" }),
  ]);
  expect(h2.sentPrompts).toEqual([]);

  // Once the child is lazily loaded, its first snapshot in this fresh
  // process is a synthetic "idle" that this process never actually watched
  // transition from "running" — there is no durable terminal receipt for it
  // either (the crash happened before any terminal event was ever
  // detected). This must NOT be treated as completion: no delivery, and the
  // watch stays active/unresolved rather than being fabricated into
  // "stopped".
  h2.agents.set("child-1", makeFakeAgent("child-1", "idle"));
  h2.setLifecycle("child-1", "idle");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h2.sentPrompts).toEqual([]);
  expect((await h2.agentStorage.get("caller-1"))?.finishNotificationDeliveries ?? []).toEqual([]);
  expect((await h2.agentStorage.get("child-1"))?.finishNotificationWatches?.[0]?.status).toBe(
    "active",
  );
  stop();
});

test("re-registering before a run receipt reuses one pending launch intent", async () => {
  const h = createFinishHarness();
  h.records.set("child-1", makeRecord("child-1"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  // Simulates a duplicate registration for a launch attempt that never
  // actually reaches a real provider turn: before any turnId is observed,
  // No run identity exists yet, so the durable pending intent is reusable.
  // It must not be treated as evidence of a completed run.
  const watchA = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  const watchB = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });

  expect(watchB.watchId).toBe(watchA.watchId);
  expect(watchB.launchToken).toBe(watchA.launchToken);
  expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches).toHaveLength(1);
});

test("re-registering after the prior watch already stopped creates a genuinely new watch, not a stale reuse", async () => {
  const h = createFinishHarness();
  h.records.set("child-1", makeRecord("child-1"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watchA = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  await cancelFinishNotificationWatch(deps, { childAgentId: "child-1", watch: watchA });

  const watchB = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });

  expect(watchB.watchId).not.toBe(watchA.watchId);
  expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches).toEqual([
    expect.objectContaining({ watchId: watchA.watchId, status: "stopped" }),
    expect.objectContaining({ watchId: watchB.watchId, status: "active" }),
  ]);
});

test("a durable-record write failure preserves the observed run across restart before a newer run", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));
  h.lastAssistantMessages.set("child-1", "Finished, but the storage write is about to fail once.");

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });

  // Simulate the exact failure window: the durable write that
  // recordFinishNotificationEvent performs (an upsert on the CHILD's own
  // record, read inside `updateRecord`) fails once. If `stop()`/
  // `markWatchStopped` ran BEFORE this write (the bug), the watch would
  // already be persisted "stopped" despite the event never being durably
  // recorded — a daemon restart would then never retry it and the event
  // would be lost forever.
  const originalUpsert = h.agentStorage.upsert.bind(h.agentStorage);
  let failuresRemaining = 1;
  vi.spyOn(h.agentStorage, "upsert").mockImplementation(async (record: StoredAgentRecord) => {
    if (record.id === "caller-1" && failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error("simulated storage write failure during delivery recording");
    }
    return originalUpsert(record);
  });

  h.setLifecycle("child-1", "idle");

  // The caller-side write failed, but the write-ahead receipt on the CHILD's
  // own record (persisted BEFORE that cross-record write, and never mocked
  // to fail here) must have durably landed: the watch stays active with the
  // exact observed run receipt AND a pending terminal detection capturing
  // what was witnessed.
  let persistedDetectedAt: string | undefined;
  await vi.waitFor(async () => {
    const child = await h.agentStorage.get("child-1");
    const persistedWatch = child?.finishNotificationWatches?.[0];
    expect(persistedWatch).toEqual(
      expect.objectContaining({
        watchId: watch.watchId,
        status: "active",
        observedRunId: "turn-1",
        observedRunStartedAt: "2026-09-06T00:00:00.000Z",
      }),
    );
    const persistedDetection = child?.finishNotificationPendingTerminalDetections?.find(
      (detection) => detection.watchId === watch.watchId,
    );
    expect(persistedDetection).toEqual(
      expect.objectContaining({
        reason: "finished",
        runId: "turn-1",
        runStartedAt: "2026-09-06T00:00:00.000Z",
        childTitle: "Child Agent",
        lastAssistantMessage: "Finished, but the storage write is about to fail once.",
      }),
    );
    persistedDetectedAt = persistedDetection?.detectedAt;
  });
  expect(h.sentPrompts).toEqual([]);
  expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries ?? []).toEqual([]);

  // Restart. Resume must replay the caller delivery directly from the
  // durable write-ahead receipt — no provider/manager observation, and no
  // re-read of the child's live last-assistant-message (h2 never populates
  // one, so a live re-read would yield null instead of the captured text).
  const h2 = createFinishHarness();
  for (const [id, record] of h.records) h2.records.set(id, record);
  h2.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));

  const stop = await resumePendingFinishNotificationDeliveries(h2.createDependencies());
  await vi.waitFor(() => expect(h2.sentPrompts).toHaveLength(1));
  const resumedChild = await h2.agentStorage.get("child-1");
  expect(resumedChild?.finishNotificationWatches).toEqual([
    expect.objectContaining({
      watchId: watch.watchId,
      status: "stopped",
    }),
  ]);
  expect(
    resumedChild?.finishNotificationPendingTerminalDetections?.some(
      (detection) => detection.watchId === watch.watchId,
    ),
  ).toBe(false);
  const replayedDelivery = (await h2.agentStorage.get("caller-1"))
    ?.finishNotificationDeliveries?.[0];
  expect(replayedDelivery).toEqual(
    expect.objectContaining({
      watchId: watch.watchId,
      reason: "finished",
      lastAssistantMessage: "Finished, but the storage write is about to fail once.",
      detectedAt: persistedDetectedAt,
    }),
  );

  // The now-stopped watch's durable observedRunId is still non-null, so a
  // later registration mints a genuinely new watch rather than reusing it.
  const newerWatch = await registerFinishNotificationWatch(h2.createDependencies(), {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  expect(newerWatch.watchId).not.toBe(watch.watchId);
  stop();
});

test("replay of a pending terminal detection is skipped when it no longer correlates with the watch's observed run", async () => {
  const h = createFinishHarness();
  h.records.set(
    "child-1",
    makeRecord("child-1", {
      finishNotificationWatches: [
        {
          watchId: "watch-1",
          callerAgentId: "caller-1",
          requireParentOwnership: false,
          launchToken: "token-1",
          observedRunId: "turn-2",
          observedRunStartedAt: "2026-09-06T00:05:00.000Z",
          registeredAt: "2026-09-06T00:00:00.000Z",
          status: "active",
        },
      ],
      // Stale receipt from an earlier run that this watch was later
      // reused/re-observed for — must never be replayed against the
      // watch's now-different observed run.
      finishNotificationPendingTerminalDetections: [
        {
          watchId: "watch-1",
          reason: "finished",
          runId: "turn-1",
          runStartedAt: "2026-09-06T00:00:00.000Z",
          detectedAt: "2026-09-06T00:01:00.000Z",
          childTitle: "Child Agent",
          lastAssistantMessage: "Stale.",
        },
      ],
    }),
  );
  h.records.set("caller-1", makeRecord("caller-1"));

  const stop = await resumePendingFinishNotificationDeliveries(h.createDependencies());
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(h.sentPrompts).toEqual([]);
  expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries ?? []).toEqual([]);
  // Left unresolved, exactly as persisted: neither fabricated into a
  // delivery nor silently discarded.
  expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches?.[0]).toEqual(
    expect.objectContaining({ status: "active" }),
  );
  stop();
});

test("a concurrently cancelled watch never resurrects into a caller delivery even if a detection was already in flight", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  await vi.waitFor(async () => {
    expect(
      (await h.agentStorage.get("child-1"))?.finishNotificationWatches?.[0]?.observedRunId,
    ).toBe("turn-1");
  });

  // Cancel the watch (e.g. a racing detach/revoke) right as the terminal
  // event is about to be detected: `persistPendingTerminalDetection` must
  // see the now-"stopped" watch and refuse to write, so the cross-record
  // caller delivery is never created for a watch that no longer exists.
  await cancelFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(h.sentPrompts).toEqual([]);
  expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries ?? []).toEqual([]);
  expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches).toEqual([
    expect.objectContaining({ watchId: watch.watchId, status: "stopped" }),
  ]);
});

test("resume reconciles a watch left active by a crash between a successful caller delivery and the final stop write, without redelivering", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h.records.set("caller-1", makeRecord("caller-1"));

  // Simulate a crash exactly between the two writes `detect()` performs
  // once terminal: the caller-side delivery write (`recordFinishNotificationEvent`)
  // succeeds, but the following child-side `markWatchStopped` write fails.
  let callerWritten = false;
  let childFailureArmed = false;
  const originalUpsert = h.agentStorage.upsert.bind(h.agentStorage);
  vi.spyOn(h.agentStorage, "upsert").mockImplementation(async (record: StoredAgentRecord) => {
    if (record.id === "caller-1") {
      callerWritten = true;
      return originalUpsert(record);
    }
    if (record.id === "child-1" && callerWritten && !childFailureArmed) {
      childFailureArmed = true;
      throw new Error("simulated crash before the final markWatchStopped write completes");
    }
    return originalUpsert(record);
  });

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });
  // The caller-side delivery landed durably, but the crash left the
  // child-side watch still "active" — the exact gap this reconciliation
  // closes.
  expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches?.[0]?.status).toBe(
    "active",
  );

  const h2 = createFinishHarness();
  for (const [id, record] of h.records) h2.records.set(id, record);
  h2.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));

  let reattachedChildWatchers = 0;
  const spyDeps = h2.createDependencies();
  const originalSubscribe = h2.agentManager.subscribe.bind(h2.agentManager);
  vi.spyOn(h2.agentManager, "subscribe").mockImplementation((cb, options) => {
    if (options?.agentId === "child-1") reattachedChildWatchers += 1;
    return originalSubscribe(cb, options);
  });

  const stop = await resumePendingFinishNotificationDeliveries(spyDeps);
  await vi.waitFor(() => expect(h2.sentPrompts).toHaveLength(1));
  // Reconciled directly from the existing caller-side delivery — no
  // reattachment, and exactly one delivery (no duplicate).
  expect(reattachedChildWatchers).toBe(0);
  expect((await h2.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  expect((await h2.agentStorage.get("child-1"))?.finishNotificationWatches?.[0]?.status).toBe(
    "stopped",
  );
  stop();
});

test("resumePendingFinishNotificationDeliveries checks the CALLER's delivery ledger, not the watched child's own record", async () => {
  const h1 = createFinishHarness();
  h1.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h1.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h1.records.set("child-1", makeRecord("child-1"));
  h1.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h1.records.set("caller-1", makeRecord("caller-1"));

  const deps1 = h1.createDependencies();
  const watch = await registerFinishNotificationWatch(deps1, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps1, { childAgentId: "child-1", watch });
  h1.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h1.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });
  // The delivery landed on the CALLER's record. The child's own record never
  // carries `finishNotificationDeliveries` for anything it triggered.
  expect((await h1.agentStorage.get("child-1"))?.finishNotificationDeliveries ?? []).toEqual([]);

  // The caller never went idle before the simulated crash, so the delivery
  // is still undelivered when we "restart".
  const h2 = createFinishHarness();
  for (const [id, record] of h1.records) h2.records.set(id, record);
  h2.agents.set("child-1", makeFakeAgent("child-1", "idle"));
  h2.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));

  let reattachedChildWatchers = 0;
  const spyDeps = h2.createDependencies();
  const originalSubscribe = h2.agentManager.subscribe.bind(h2.agentManager);
  vi.spyOn(h2.agentManager, "subscribe").mockImplementation((cb, options) => {
    if (options?.agentId === "child-1") reattachedChildWatchers += 1;
    return originalSubscribe(cb, options);
  });

  const stop = await resumePendingFinishNotificationDeliveries(spyDeps);
  // The already-recorded (if not yet delivered) event must not cause a
  // second watcher to re-attach and re-detect "child-1" all over again:
  // checking the wrong (child) record for `finishNotificationDeliveries`
  // would always see zero entries there and re-attach spuriously.
  expect(reattachedChildWatchers).toBe(0);
  await vi.waitFor(() => expect(h2.sentPrompts).toHaveLength(1));
  stop();
});

test("caller-side write-lease revocation drops pending notifications before a futile retry loop, distinct from parent-label detach", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "running"));
  h.records.set(
    "caller-1",
    makeRecord("caller-1", {
      leadHandoffs: [
        {
          id: "handoff-1",
          status: "predecessor_released",
          currentWriteOwnerAgentId: "successor-1",
          predecessorAgentId: "caller-1",
          successorAgentId: "successor-1",
          createdAt: new Date().toISOString(),
        } as never,
      ],
    }),
  );

  const deps = h.createDependencies();
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");
  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries).toHaveLength(1);
  });

  h.setLifecycle("caller-1", "idle");
  await new Promise((resolve) => setTimeout(resolve, 50));

  // A released write lease is not a parent-label detach (labels are
  // untouched here) — it must still gate delivery, and it must do so as a
  // clean drop rather than the bounded-retry churn `sendPromptToAgent`'s
  // own lease assertion would otherwise trigger downstream.
  expect(h.sentPrompts).toEqual([]);
  const delivery = (await h.agentStorage.get("caller-1"))?.finishNotificationDeliveries?.[0];
  expect(delivery?.deliveredAt).toBeNull();
  expect(delivery?.droppedAt).not.toBeNull();
});

test("an unwired council resolver fails closed and redacts content", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));
  h.lastAssistantMessages.set(
    "child-1",
    "Content that would need sealing if this were a Council seat.",
  );

  const logger = createTestLogger();
  const warnSpy = vi.spyOn(logger, "warn");
  const deps: FinishNotificationDependencies = {
    agentManager: h.agentManager,
    agentStorage: h.agentStorage,
    logger,
    // No resolveCouncilSeatProjection: the unwired-integration-seam case.
  };
  const watch = await registerFinishNotificationWatch(deps, {
    childAgentId: "child-1",
    callerAgentId: "caller-1",
  });
  attachFinishNotificationWatch(deps, { childAgentId: "child-1", watch });
  h.setLifecycle("child-1", "idle");

  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1));
  expect(h.sentPrompts[0]?.prompt).not.toContain(
    "Content that would need sealing if this were a Council seat.",
  );
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({ childAgentId: "child-1" }),
    expect.stringContaining("resolveCouncilSeatProjection is not wired"),
  );
});

test("setupFinishNotification composes register+attach for call sites that dispatch first", async () => {
  const h = createFinishHarness();
  h.agents.set("child-1", makeFakeAgent("child-1", "running"));
  h.agents.get("child-1")!.activeForegroundTurnId = "turn-1";
  h.records.set("child-1", makeRecord("child-1"));
  h.agents.set("caller-1", makeFakeAgent("caller-1", "idle"));
  h.records.set("caller-1", makeRecord("caller-1"));

  setupFinishNotification({
    agentManager: h.agentManager,
    agentStorage: h.agentStorage,
    childAgentId: "child-1",
    callerAgentId: "caller-1",
    logger: createTestLogger(),
  });
  await vi.waitFor(async () => {
    expect((await h.agentStorage.get("child-1"))?.finishNotificationWatches).toHaveLength(1);
  });

  h.setLifecycle("child-1", "idle");
  await vi.waitFor(() => expect(h.sentPrompts).toHaveLength(1));
});
