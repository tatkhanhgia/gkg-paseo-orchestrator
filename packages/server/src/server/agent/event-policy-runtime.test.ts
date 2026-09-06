import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentManagerEvent, AgentSubscriber } from "./agent-manager.js";
import {
  startEventPolicyRuntime,
  type AgentEventPolicy,
  type EventPolicyRuntimeDependencies,
} from "./event-policy-runtime.js";

function event(turnId: string): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId: "lead-1",
    event: { type: "turn_started", turnId },
  };
}

function harness() {
  let subscriber: AgentSubscriber | null = null;
  const dependencies = {
    agentManager: {
      subscribe(callback: AgentSubscriber) {
        subscriber = callback;
        return () => {
          subscriber = null;
        };
      },
    },
    logger: { warn: vi.fn() } as unknown as Logger,
  } as unknown as EventPolicyRuntimeDependencies;
  return {
    dependencies,
    emit(next: AgentManagerEvent) {
      subscriber?.(next);
    },
    subscribed() {
      return subscriber !== null;
    },
  };
}

async function ignoreEvent(): Promise<void> {}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("event policy runtime", () => {
  test("loads only enabled policies and tears down the generic subscription", () => {
    const runtimeHarness = harness();
    const handleEvent = vi.fn(ignoreEvent);
    const createProcessor = vi.fn(() => ({ handleEvent }));
    const policies: AgentEventPolicy[] = [
      { id: "enabled", version: "1", enabled: () => true, createProcessor },
      { id: "disabled", version: "1", enabled: () => false, createProcessor },
    ];

    const runtime = startEventPolicyRuntime({
      dependencies: runtimeHarness.dependencies,
      policies,
      environment: {},
    });

    expect(runtime.enabledPolicies).toEqual([{ id: "enabled", version: "1" }]);
    expect(createProcessor).toHaveBeenCalledTimes(1);
    expect(runtimeHarness.subscribed()).toBe(true);
    runtime.stop();
    expect(runtimeHarness.subscribed()).toBe(false);
  });

  test("serializes each policy-agent lane and isolates processor failures", async () => {
    const runtimeHarness = harness();
    const handled: string[] = [];
    const policy: AgentEventPolicy = {
      id: "test.policy",
      version: "1",
      enabled: () => true,
      createProcessor: () => ({
        async handleEvent(next) {
          if (next.type !== "agent_stream") return;
          handled.push(next.event.type === "turn_started" ? next.event.turnId : "unexpected");
          if (handled.length === 1) throw new Error("policy failure");
        },
      }),
    };
    const runtime = startEventPolicyRuntime({
      dependencies: runtimeHarness.dependencies,
      policies: [policy],
    });

    runtimeHarness.emit(event("turn-1"));
    runtimeHarness.emit(event("turn-2"));

    await vi.waitFor(() => expect(handled).toEqual(["turn-1", "turn-2"]));
    expect(runtimeHarness.dependencies.logger.warn).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  test("resolves exact owner-qualified policies for each target agent", async () => {
    const runtimeHarness = harness();
    const handled: string[] = [];
    const currentPolicy: AgentEventPolicy = {
      id: "slp.attention",
      version: "3",
      enabled: () => true,
      createProcessor: () => ({
        async handleEvent(_event, context) {
          handled.push(context.stateNamespace);
        },
      }),
    };
    const runtime = startEventPolicyRuntime({
      dependencies: runtimeHarness.dependencies,
      advertisedPolicies: [currentPolicy],
      resolvePolicies: (agentId) =>
        agentId === "lead-1"
          ? [{ policy: currentPolicy, stateNamespace: "slp@current-digest" }]
          : [],
    });

    runtimeHarness.emit(event("turn-current"));
    runtimeHarness.emit({ ...event("turn-legacy"), agentId: "legacy-1" });
    await vi.waitFor(() => expect(handled).toEqual(["slp@current-digest"]));
    runtime.stop();
  });

  test("quiesces a held lane and suppresses queued work after stop", async () => {
    const runtimeHarness = harness();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let handled = 0;
    let disposed = false;
    const policy: AgentEventPolicy = {
      id: "held.policy",
      version: "1",
      enabled: () => true,
      createProcessor: () => ({
        async handleEvent() {
          handled += 1;
          if (handled === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
        },
        dispose() {
          disposed = true;
        },
      }),
    };
    const runtime = startEventPolicyRuntime({
      dependencies: runtimeHarness.dependencies,
      policies: [policy],
    });

    runtimeHarness.emit(event("turn-held"));
    await firstStarted.promise;
    runtimeHarness.emit(event("turn-queued"));
    const stopping = runtime.stop();
    expect(runtimeHarness.subscribed()).toBe(false);
    releaseFirst.resolve();
    await stopping;

    expect(handled).toBe(1);
    expect(disposed).toBe(true);
  });
});
