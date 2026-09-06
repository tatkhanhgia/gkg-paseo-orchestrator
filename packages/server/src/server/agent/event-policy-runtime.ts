import type { Logger } from "pino";

import type { AgentManager, AgentManagerEvent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { CoordinationSignalDependencies } from "./coordination-signals.js";

type EventPolicyAgentManager = Pick<
  AgentManager,
  | "getAgent"
  | "hasInFlightRun"
  | "listAgents"
  | "notifyAgentAttention"
  | "notifyAgentState"
  | "subscribe"
>;

export interface EventPolicyRuntimeDependencies extends Omit<
  CoordinationSignalDependencies,
  "agentManager" | "agentStorage"
> {
  agentManager: EventPolicyAgentManager;
  agentStorage: Pick<AgentStorage, "get" | "upsert" | "list">;
  logger: Logger;
}

export interface AgentEventPolicyProcessor {
  handleEvent(event: AgentManagerEvent, context: AgentEventPolicyDispatchContext): Promise<void>;
  dispose?(): void;
}

export interface AgentEventPolicyDispatchContext {
  stateNamespace: string;
}

export interface ResolvedAgentEventPolicy extends AgentEventPolicyDispatchContext {
  policy: AgentEventPolicy;
}

export interface AgentEventPolicy {
  id: string;
  version: string;
  /**
   * Event kinds this policy is allowed to receive from the shared host. Existing policies keep
   * the historical stream-only default; lifecycle-aware policies must opt in explicitly.
   */
  subscriptions?: readonly AgentManagerEvent["type"][];
  enabled(environment: NodeJS.ProcessEnv): boolean;
  createProcessor(dependencies: EventPolicyRuntimeDependencies): AgentEventPolicyProcessor;
}

export interface EventPolicyRuntime {
  enabledPolicies: Array<{ id: string; version: string }>;
  /** Stop intake and resolve only after already-running policy lanes quiesce. */
  stop(): Promise<void>;
}

/**
 * Generic event-policy host. Policy owns meaning; the kernel owns subscription,
 * per-agent serialization, failure isolation, and teardown.
 */
export function startEventPolicyRuntime(input: {
  dependencies: EventPolicyRuntimeDependencies;
  policies?: readonly AgentEventPolicy[];
  resolvePolicies?: (
    agentId: string,
    event: AgentManagerEvent,
  ) => readonly ResolvedAgentEventPolicy[];
  advertisedPolicies?: readonly AgentEventPolicy[];
  environment?: NodeJS.ProcessEnv;
}): EventPolicyRuntime {
  const environment = input.environment ?? process.env;
  const advertisedPolicies = input.advertisedPolicies ?? input.policies ?? [];
  const staticPolicies = (input.policies ?? [])
    .filter((policy) => policy.enabled(environment))
    .map((policy) => ({ policy, stateNamespace: "static" }));
  const processors = new Map<
    string,
    { policy: AgentEventPolicy; processor: AgentEventPolicyProcessor }
  >();
  for (const { policy, stateNamespace } of staticPolicies) {
    processors.set(`${stateNamespace}:${policy.id}:${policy.version}`, {
      policy,
      processor: policy.createProcessor(input.dependencies),
    });
  }
  const queues = new Map<string, Promise<void>>();
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  const unsubscribe = input.dependencies.agentManager.subscribe(
    (event) => {
      if (stopped) return;
      const agentId = agentIdForEvent(event);
      let resolved: readonly ResolvedAgentEventPolicy[];
      try {
        resolved = input.resolvePolicies?.(agentId, event) ?? staticPolicies;
      } catch (error) {
        input.dependencies.logger.warn(
          { err: error, agentId },
          "Agent event policy owner could not be resolved",
        );
        return;
      }
      for (const { policy, stateNamespace } of resolved) {
        if (!policy.enabled(environment)) continue;
        if (!(policy.subscriptions ?? ["agent_stream"]).includes(event.type)) continue;
        const processorKey = `${stateNamespace}:${policy.id}:${policy.version}`;
        let entry = processors.get(processorKey);
        if (!entry) {
          entry = { policy, processor: policy.createProcessor(input.dependencies) };
          processors.set(processorKey, entry);
        }
        const processor = entry.processor;
        const queueKey = `${processorKey}:${agentId}`;
        const previous = queues.get(queueKey) ?? Promise.resolve();
        const current = previous
          .then(async () => {
            // A stop can happen while this event is waiting behind another lane item. The
            // stopped-generation guard prevents queued work from starting after teardown.
            if (stopped) return undefined;
            return processor.handleEvent(event, { stateNamespace });
          })
          .catch((error) => {
            input.dependencies.logger.warn(
              { err: error, agentId, policyId: policy.id },
              "Agent event policy failed to process an event",
            );
          })
          .finally(() => {
            if (queues.get(queueKey) === current) queues.delete(queueKey);
          });
        queues.set(queueKey, current);
      }
    },
    { replayState: false },
  );

  return {
    enabledPolicies: advertisedPolicies
      .filter((policy) => policy.enabled(environment))
      .map((policy) => ({ id: policy.id, version: policy.version })),
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      unsubscribe();
      const inFlight = [...queues.values()];
      stopPromise = Promise.allSettled(inFlight).then(() => {
        queues.clear();
        for (const { processor } of processors.values()) processor.dispose?.();
        return undefined;
      });
      return stopPromise;
    },
  };
}

function agentIdForEvent(event: AgentManagerEvent): string {
  if (event.type === "agent_state") return event.agent.id;
  if (event.type === "provider_subagent") {
    return event.event.type === "upsert"
      ? event.event.subagent.parentAgentId
      : event.event.parentAgentId;
  }
  return event.agentId;
}
