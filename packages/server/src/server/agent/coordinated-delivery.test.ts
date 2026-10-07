import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentManagerEvent } from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  createPendingDeliveryChannel,
  createSerializedRecordUpdateQueue,
  type PendingDeliveryChannelConfig,
  type PendingDeliveryChannelDependencies,
  type SerializedRecordUpdateDependencies,
} from "./coordinated-delivery.js";

interface TestItem {
  id: string;
  value: string;
  deliveredAt: string | null;
}

interface TestRecord extends StoredAgentRecord {
  items: TestItem[];
}

function makeRecord(
  id: string,
  items: TestItem[] = [],
  overrides: Partial<StoredAgentRecord> = {},
): TestRecord {
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
    items,
    ...overrides,
  } as TestRecord;
}

function createHarness(
  options: { running?: boolean; retryBackoffMs?: (attempt: number) => number } = {},
) {
  let running = options.running ?? false;
  const records = new Map<string, TestRecord>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const delivered: Array<{ agentId: string; items: TestItem[] }> = [];
  const failuresRemaining = new Map<string, number>();

  const dependencies: PendingDeliveryChannelDependencies & SerializedRecordUpdateDependencies = {
    agentStorage: {
      get: vi.fn(async (id: string) => records.get(id) ?? null),
      upsert: vi.fn(async (record: StoredAgentRecord) => {
        records.set(record.id, record as TestRecord);
      }),
      list: vi.fn(async () => Array.from(records.values())),
    },
    agentManager: {
      getAgent: vi.fn(() => null),
      hasInFlightRun: vi.fn(() => running),
      notifyAgentState: vi.fn(),
      subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      }),
    },
    logger: pino({ level: "silent" }),
  };

  const config: PendingDeliveryChannelConfig<TestItem> = {
    channelName: "test-channel",
    getPending: (record) =>
      (record as TestRecord).items.filter((item) => item.deliveredAt === null),
    itemId: (item) => item.id,
    deliver: vi.fn(async (agentId: string, items: TestItem[]) => {
      const remaining = failuresRemaining.get(agentId) ?? 0;
      if (remaining > 0) {
        failuresRemaining.set(agentId, remaining - 1);
        throw new Error("transient send failure");
      }
      delivered.push({ agentId, items });
      return { dispatchedIds: items.map((item) => item.id) };
    }),
    markDelivered: async (updateRecord, agentId, deliveredIds, deliveredAt) => {
      await updateRecord(agentId, (record) => {
        const items = (record as TestRecord).items.map((item) =>
          deliveredIds.has(item.id) && item.deliveredAt === null
            ? Object.assign({}, item, { deliveredAt })
            : item,
        );
        return { record: { ...record, items }, result: undefined };
      });
    },
    maxInProcessRetries: 2,
    retryBackoffMs: options.retryBackoffMs ?? (() => 20),
  };

  return {
    records,
    delivered,
    failuresRemaining,
    dependencies,
    config,
    setRunning(value: boolean) {
      running = value;
    },
    reachIdleBoundary(agentId: string) {
      running = false;
      for (const subscriber of subscribers) {
        subscriber({ type: "agent_state", agent: { id: agentId, lifecycle: "idle" } as never });
      }
    },
  };
}

function deliveredItemIds(delivered: Array<{ agentId: string; items: TestItem[] }>): string[] {
  const ids: string[] = [];
  for (const { items } of delivered) {
    for (const item of items) ids.push(item.id);
  }
  return ids;
}

describe("coordinated-delivery", () => {
  test("serializes concurrent read-modify-write on the same record without losing an update", async () => {
    const harness = createHarness();
    harness.records.set("agent-1", makeRecord("agent-1", []));
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);

    const append = (id: string) =>
      updateRecord("agent-1", (record) => {
        const items = [...(record as TestRecord).items, { id, value: id, deliveredAt: null }];
        return { record: { ...record, items }, result: undefined };
      });

    await Promise.all([append("a"), append("b"), append("c")]);

    expect(
      harness.records
        .get("agent-1")!
        .items.map((item) => item.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });

  test("two independent consumer modules sharing one AgentStorage get the identical serialization queue and don't clobber each other's fields", async () => {
    // finish-notification.ts and coordination-signals.ts each cache
    // createSerializedRecordUpdateQueue(dependencies) behind their OWN
    // per-module WeakMap<AgentStorage, ...>, so each independently calls
    // this factory on its own first use for a given AgentStorage. Before
    // sharing identity at the storage level inside this primitive, that
    // produced two private `recordUpdates` Maps for the same underlying
    // storage: a concurrent write from each module against the same
    // caller/child record could both read the pre-write snapshot and then
    // each overwrite the other's field on upsert.
    const harness = createHarness();
    harness.records.set("agent-1", makeRecord("agent-1", []));

    const { updateRecord: updateRecordFromModuleA } = createSerializedRecordUpdateQueue(
      harness.dependencies,
    );
    const { updateRecord: updateRecordFromModuleB } = createSerializedRecordUpdateQueue(
      harness.dependencies,
    );

    expect(updateRecordFromModuleA).toBe(updateRecordFromModuleB);

    const writeField = (
      updateRecord: typeof updateRecordFromModuleA,
      field: string,
      value: unknown,
    ) =>
      updateRecord("agent-1", (record) => ({
        record: { ...record, [field]: value },
        result: undefined,
      }));

    await Promise.all([
      writeField(updateRecordFromModuleA, "finishNotificationDeliveries", [{ marker: "from-a" }]),
      writeField(updateRecordFromModuleB, "coordinationSignals", [{ marker: "from-b" }]),
    ]);

    const record = harness.records.get("agent-1") as unknown as Record<string, unknown>;
    expect(record.finishNotificationDeliveries).toEqual([{ marker: "from-a" }]);
    expect(record.coordinationSignals).toEqual([{ marker: "from-b" }]);
  });

  test("continues the update queue after a preceding write rejects", async () => {
    const harness = createHarness();
    harness.records.set("agent-1", makeRecord("agent-1", []));
    vi.mocked(harness.dependencies.agentStorage.upsert).mockRejectedValueOnce(
      new Error("first write failed"),
    );
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);

    const first = updateRecord("agent-1", (record) => ({
      record: { ...record, items: [{ id: "a", value: "a", deliveredAt: null }] },
      result: undefined,
    }));
    const second = updateRecord("agent-1", (record) => ({
      record: {
        ...record,
        items: [...(record as TestRecord).items, { id: "b", value: "b", deliveredAt: null }],
      },
      result: undefined,
    }));

    await expect(first).rejects.toThrow("first write failed");
    await expect(second).resolves.toBeUndefined();
    expect(harness.records.get("agent-1")!.items.map((item) => item.id)).toEqual(["b"]);
  });

  test("withholds delivery while the recipient has an in-flight run, then delivers once idle", async () => {
    const harness = createHarness({ running: true });
    harness.records.set(
      "agent-1",
      makeRecord("agent-1", [{ id: "a", value: "a", deliveredAt: null }]),
    );
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);
    const channel = createPendingDeliveryChannel(
      harness.dependencies,
      updateRecord,
      harness.config,
    );

    channel.scheduleDelivery("agent-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.delivered).toEqual([]);

    harness.reachIdleBoundary("agent-1");
    await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
    expect(harness.records.get("agent-1")!.items[0]?.deliveredAt).not.toBeNull();
  });

  test("recovers a transient delivery failure via bounded in-process retry with no further trigger event", async () => {
    const harness = createHarness({ running: false });
    harness.records.set(
      "agent-1",
      makeRecord("agent-1", [{ id: "a", value: "a", deliveredAt: null }]),
    );
    harness.failuresRemaining.set("agent-1", 1);
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);
    const channel = createPendingDeliveryChannel(
      harness.dependencies,
      updateRecord,
      harness.config,
    );

    // scheduleDelivery is called exactly once; no subsequent idle event is ever
    // dispatched. Recovery must come from the bounded in-process retry, not from
    // waiting on a future agent_state transition that never arrives.
    channel.scheduleDelivery("agent-1");

    await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
    expect(harness.records.get("agent-1")!.items[0]?.deliveredAt).not.toBeNull();
  });

  test("gives up after the bounded retry ceiling instead of retrying forever", async () => {
    const harness = createHarness({ running: false });
    harness.records.set(
      "agent-1",
      makeRecord("agent-1", [{ id: "a", value: "a", deliveredAt: null }]),
    );
    harness.failuresRemaining.set("agent-1", 99);
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);
    const channel = createPendingDeliveryChannel(
      harness.dependencies,
      updateRecord,
      harness.config,
    );

    channel.scheduleDelivery("agent-1");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.delivered).toEqual([]);
    expect(harness.records.get("agent-1")!.items[0]?.deliveredAt).toBeNull();
  });

  test("delivers an item persisted while a delivery is mid-flight without waiting for another idle event", async () => {
    const harness = createHarness({ running: false });
    harness.records.set(
      "agent-1",
      makeRecord("agent-1", [{ id: "a", value: "a", deliveredAt: null }]),
    );
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);
    let releaseFirstSend: () => void = () => {};
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let sends = 0;
    const channel = createPendingDeliveryChannel(harness.dependencies, updateRecord, {
      ...harness.config,
      deliver: async (agentId, items) => {
        sends += 1;
        if (sends === 1) await firstSendGate;
        harness.delivered.push({ agentId, items });
        return { dispatchedIds: items.map((item) => item.id) };
      },
    });

    channel.scheduleDelivery("agent-1");
    await vi.waitFor(() => expect(sends).toBe(1));
    // The recipient stays idle for good: no agent_state event follows, so the second item can
    // only be delivered by the drain that finds it after the first send completes.
    await updateRecord("agent-1", (record) => ({
      record: {
        ...record,
        items: [...(record as TestRecord).items, { id: "b", value: "b", deliveredAt: null }],
      } as TestRecord,
      result: undefined,
    }));
    channel.scheduleDelivery("agent-1");
    releaseFirstSend();

    await vi.waitFor(() => expect(deliveredItemIds(harness.delivered)).toEqual(["a", "b"]));
  });

  test("a failed delivery pass is retried only by the bounded retry timer, even if its failure re-notifies the recipient", async () => {
    const harness = createHarness({ running: false });
    harness.records.set(
      "agent-1",
      makeRecord("agent-1", [{ id: "a", value: "a", deliveredAt: null }]),
    );
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);
    let sends = 0;
    let failureNotifications = 0;
    const channel = createPendingDeliveryChannel(harness.dependencies, updateRecord, {
      ...harness.config,
      deliver: async () => {
        sends += 1;
        throw new Error("persistent send failure");
      },
      // Persisting the failure goes through updateRecord, which notifies agent state; an idle
      // recipient then emits an idle event while this pass is still in flight. The cap only
      // lets an unbounded implementation terminate so the test can fail instead of hang.
      markFailed: async (_updateRecord, agentId) => {
        failureNotifications += 1;
        if (failureNotifications < 50) harness.reachIdleBoundary(agentId);
      },
    });

    channel.scheduleDelivery("agent-1");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // One initial pass plus maxInProcessRetries (2) timer-driven retries.
    expect(sends).toBe(3);
  });

  test("resumePendingDeliveries reschedules every record with undelivered items after a restart", async () => {
    const harness = createHarness({ running: false });
    harness.records.set(
      "agent-1",
      makeRecord("agent-1", [{ id: "a", value: "a", deliveredAt: null }]),
    );
    harness.records.set("agent-2", makeRecord("agent-2", []));
    const { updateRecord } = createSerializedRecordUpdateQueue(harness.dependencies);
    const channel = createPendingDeliveryChannel(
      harness.dependencies,
      updateRecord,
      harness.config,
    );

    const stop = await channel.resumePendingDeliveries();
    await vi.waitFor(() =>
      expect(harness.delivered).toEqual([{ agentId: "agent-1", items: expect.any(Array) }]),
    );
    stop();
  });
});
