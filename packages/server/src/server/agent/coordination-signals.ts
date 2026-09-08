import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  CoordinationSignal,
  CoordinationSignalKind,
  CoordinationSignalRecipientRole,
  CoordinationSignalResolution,
  CoordinationSignalSeverity,
  CoordinationSignalSource,
  CoordinationSignalTrigger,
} from "@getpaseo/protocol/coordination-signal";

import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import {
  createPendingDeliveryChannel,
  createSerializedRecordUpdateQueue,
  type PendingDeliveryDispatchResult,
  type UpdateRecordFn,
} from "./coordinated-delivery.js";

type CoordinationAgentManager = Pick<
  AgentManager,
  "getAgent" | "hasInFlightRun" | "notifyAgentState" | "subscribe"
>;

export interface CoordinationSignalDependencies {
  agentManager: CoordinationAgentManager;
  agentStorage: Pick<AgentStorage, "get" | "upsert" | "list">;
  sendAtSafeBoundary: (agentId: string, message: string) => Promise<void>;
  logger: Logger;
}

export interface RequestCoordinationSignalInput {
  targetAgentId: string;
  requestedByAgentId: string | null;
  kind: CoordinationSignalKind;
  trigger?: CoordinationSignalTrigger;
  customEvent?: string;
  severity?: CoordinationSignalSeverity;
  recipientRole?: CoordinationSignalRecipientRole;
  source?: CoordinationSignalSource;
  coalescingKey?: string;
  reason: string;
  observation?: string;
  question?: string;
  relatedAgentId?: string;
  evidenceRefs?: string[];
  evidence?: Record<string, string | number | boolean | null>;
}

export interface EventPolicyStateSpec<TState extends Record<string, unknown>> {
  policyId: string;
  version: number;
  initialState: TState;
  parseState: (input: unknown) => TState;
  migrateLegacy?: (record: StoredAgentRecord) => TState | null;
}

export interface EventPolicyStateOwner {
  stateNamespace: string;
}

// Keyed by the agentStorage singleton, NOT by the `dependencies` wrapper
// object. Call sites (see paseo-tools.ts) build a fresh `dependencies`
// literal per call; if the queue/channel were cached per-literal, two
// concurrent calls touching the same target agent would each get their own
// uncoordinated delivery channel and could both drain (and double-send) the
// same pending signal before either marked it delivered. Every call site
// passes the same live AgentStorage instance, so keying on it gives one real
// queue/channel per daemon process.
const updateRecordByStorage = new WeakMap<object, UpdateRecordFn>();
const deliveryChannelByStorage = new WeakMap<
  object,
  ReturnType<typeof createPendingDeliveryChannel<CoordinationSignal>>
>();

function updateRecordFor(dependencies: CoordinationSignalDependencies): UpdateRecordFn {
  let recordUpdater = updateRecordByStorage.get(dependencies.agentStorage);
  if (!recordUpdater) {
    recordUpdater = createSerializedRecordUpdateQueue(dependencies).updateRecord;
    updateRecordByStorage.set(dependencies.agentStorage, recordUpdater);
  }
  return recordUpdater;
}

function deliveryChannelFor(
  dependencies: CoordinationSignalDependencies,
): ReturnType<typeof createPendingDeliveryChannel<CoordinationSignal>> {
  // First writer wins: the channel closes over whichever `dependencies`
  // (and therefore `sendAtSafeBoundary`/logger) reaches here first for this
  // AgentStorage. Every current call site passes equivalent dependencies.
  let channel = deliveryChannelByStorage.get(dependencies.agentStorage);
  if (!channel) {
    channel = createPendingDeliveryChannel(dependencies, updateRecordFor(dependencies), {
      channelName: "coordination-signal",
      getPending: (record) =>
        record.internal || record.archivedAt
          ? []
          : (record.coordinationSignals ?? []).filter(
              (signal) => signal.status === "pending" && signal.deliveredAt === null,
            ),
      itemId: (signal) => signal.id,
      deliver: async (agentId, signals): Promise<PendingDeliveryDispatchResult> => {
        await dependencies.sendAtSafeBoundary(agentId, formatDelivery(signals));
        return { dispatchedIds: signals.map((signal) => signal.id) };
      },
      markDelivered: (recordUpdater, agentId, deliveredIds, deliveredAt) =>
        markDelivered(recordUpdater, agentId, deliveredIds, deliveredAt),
    });
    deliveryChannelByStorage.set(dependencies.agentStorage, channel);
  }
  return channel;
}

async function updateCoordinationRecord<T>(
  dependencies: CoordinationSignalDependencies,
  agentId: string,
  update: (record: StoredAgentRecord) => { record: StoredAgentRecord; result: T },
): Promise<T> {
  return updateRecordFor(dependencies)(agentId, update);
}

function formatDelivery(signals: readonly CoordinationSignal[]): string {
  const entries = signals.map((signal) => {
    const related = signal.relatedAgentId ? `\nRelated agent: ${signal.relatedAgentId}` : "";
    const evidence =
      signal.evidenceRefs.length > 0
        ? `\nEvidence refs:\n${signal.evidenceRefs.map((ref) => `- ${ref}`).join("\n")}`
        : "";
    const trigger = signal.trigger ? `\nTrigger: ${signal.trigger}` : "";
    const customEvent = signal.customEvent ? `\nCustom event: ${signal.customEvent}` : "";
    const severity = signal.severity ? `\nSeverity: ${signal.severity}` : "";
    const observation = signal.observation ? `\nObservation: ${signal.observation}` : "";
    const question = signal.question ? `\nQuestion: ${signal.question}` : "";
    const observations = signal.evidence
      ? `\nObserved metrics:\n${Object.entries(signal.evidence)
          .map(([key, value]) => `- ${key}: ${String(value)}`)
          .join("\n")}`
      : "";
    return `Signal ${signal.id}: ${signal.kind}${trigger}${customEvent}${severity}\nReason: ${signal.reason}${observation}${question}${related}${evidence}${observations}`;
  });
  const hasNativeAttention = signals.some(
    (signal) => signal.kind === "continuity_attention" && signal.source?.kind === "paseo",
  );
  return [
    hasNativeAttention ? "Paseo coordination attention." : "Paseo coordination signal.",
    "This is advisory evidence. It does not transfer authority, prescribe handoff or detach, or require a report to another role.",
    "Evaluate it at this safe boundary within your existing lease. Resolving it does not grant handoff, detach, signaling, orchestration, or acceptance authority. Use resolve_agent_signal to record your disposition.",
    ...entries,
  ].join("\n\n");
}

function sourceForInput(input: RequestCoordinationSignalInput): CoordinationSignalSource {
  return (
    input.source ??
    (input.requestedByAgentId
      ? { kind: "agent", agentId: input.requestedByAgentId }
      : { kind: "human" })
  );
}

function sourcesMatch(
  left: CoordinationSignalSource | undefined,
  right: CoordinationSignalSource,
): boolean {
  if (!left) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "agent" && right.kind === "agent") return left.agentId === right.agentId;
  if (left.kind === "paseo" && right.kind === "paseo") {
    return left.ruleId === right.ruleId && left.version === right.version;
  }
  return left.kind === "human" && right.kind === "human";
}

function signalsCoalesce(
  candidate: CoordinationSignal,
  input: RequestCoordinationSignalInput,
  source: CoordinationSignalSource,
): boolean {
  const hasExplicitLane =
    input.coalescingKey !== undefined || candidate.coalescingKey !== undefined;
  const sameExplicitLane = hasExplicitLane && candidate.coalescingKey === input.coalescingKey;
  const sameSource = candidate.source
    ? sourcesMatch(candidate.source, source)
    : candidate.requestedByAgentId === input.requestedByAgentId;
  return (
    candidate.status === "pending" &&
    candidate.kind === input.kind &&
    (hasExplicitLane ? sameExplicitLane : sameSource && candidate.trigger === input.trigger) &&
    candidate.relatedAgentId === input.relatedAgentId
  );
}

function mergeSignalOccurrence(
  existing: CoordinationSignal,
  input: RequestCoordinationSignalInput,
): CoordinationSignal {
  const occurredAt = new Date().toISOString();
  const previousOccurrences = existing.occurrences ?? [
    {
      occurredAt: existing.createdAt,
      evidenceRefs: existing.evidenceRefs,
      ...(existing.evidence ? { evidence: existing.evidence } : {}),
    },
  ];
  return {
    ...existing,
    evidenceRefs: [...new Set([...existing.evidenceRefs, ...(input.evidenceRefs ?? [])])].slice(
      -20,
    ),
    ...(input.evidence ? { evidence: { ...existing.evidence, ...input.evidence } } : {}),
    occurrenceCount: (existing.occurrenceCount ?? 1) + 1,
    lastOccurredAt: occurredAt,
    occurrences: [
      ...previousOccurrences,
      {
        occurredAt,
        evidenceRefs: input.evidenceRefs ?? [],
        ...(input.evidence ? { evidence: input.evidence } : {}),
      },
    ].slice(-20),
  };
}

function createCoordinationSignal(
  record: StoredAgentRecord,
  input: RequestCoordinationSignalInput,
  source: CoordinationSignalSource,
): CoordinationSignal {
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(),
    targetAgentId: input.targetAgentId,
    requestedByAgentId: input.requestedByAgentId,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    kind: input.kind,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.customEvent ? { customEvent: input.customEvent } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.recipientRole ? { recipientRole: input.recipientRole } : {}),
    source,
    ...(input.coalescingKey ? { coalescingKey: input.coalescingKey } : {}),
    reason: input.reason,
    ...(input.observation ? { observation: input.observation } : {}),
    ...(input.question ? { question: input.question } : {}),
    ...(input.relatedAgentId ? { relatedAgentId: input.relatedAgentId } : {}),
    evidenceRefs: input.evidenceRefs ?? [],
    ...(input.evidence ? { evidence: input.evidence } : {}),
    status: "pending",
    occurrenceCount: 1,
    lastOccurredAt: createdAt,
    createdAt,
    deliveredAt: null,
    resolvedAt: null,
  };
}

async function markDelivered(
  recordUpdater: UpdateRecordFn,
  agentId: string,
  signalIds: ReadonlySet<string>,
  deliveredAt: string,
): Promise<void> {
  await recordUpdater(agentId, (record) => {
    const coordinationSignals = [];
    for (const signal of record.coordinationSignals ?? []) {
      const shouldMark =
        signalIds.has(signal.id) && signal.status === "pending" && signal.deliveredAt === null;
      coordinationSignals.push(shouldMark ? { ...signal, deliveredAt } : signal);
    }
    return {
      record: { ...record, coordinationSignals },
      result: undefined,
    };
  });
}

function scheduleDelivery(dependencies: CoordinationSignalDependencies, agentId: string): void {
  deliveryChannelFor(dependencies).scheduleDelivery(agentId);
}

export async function requestCoordinationSignal(
  dependencies: CoordinationSignalDependencies,
  input: RequestCoordinationSignalInput,
): Promise<CoordinationSignal> {
  const source = sourceForInput(input);
  const signal = await updateCoordinationRecord(dependencies, input.targetAgentId, (record) => {
    const existing = (record.coordinationSignals ?? []).find((candidate) =>
      signalsCoalesce(candidate, input, source),
    );
    if (existing) {
      const merged = mergeSignalOccurrence(existing, input);
      const signals = [...(record.coordinationSignals ?? [])];
      signals[signals.indexOf(existing)] = merged;
      return { record: { ...record, coordinationSignals: signals }, result: merged };
    }
    const created = createCoordinationSignal(record, input, source);
    return {
      record: {
        ...record,
        coordinationSignals: [...(record.coordinationSignals ?? []), created],
      },
      result: created,
    };
  });
  scheduleDelivery(dependencies, input.targetAgentId);
  return signal;
}

export async function updateEventPolicyState<TState extends Record<string, unknown>, TResult>(
  dependencies: CoordinationSignalDependencies,
  agentId: string,
  owner: EventPolicyStateOwner,
  spec: EventPolicyStateSpec<TState>,
  update: (
    state: TState,
    record: StoredAgentRecord,
  ) => {
    state: TState;
    result: TResult;
  },
): Promise<TResult> {
  return updateCoordinationRecord(dependencies, agentId, (record) => {
    const stateKey = `${owner.stateNamespace}/${spec.policyId}`;
    const persisted = record.eventPolicyStates?.[stateKey];
    const state =
      persisted?.version === spec.version
        ? spec.parseState(persisted.state)
        : (spec.migrateLegacy?.(record) ?? spec.parseState(spec.initialState));
    const next = update(state, record);
    return {
      record: {
        ...record,
        eventPolicyStates: {
          ...record.eventPolicyStates,
          [stateKey]: {
            version: spec.version,
            state: next.state,
          },
        },
      },
      result: next.result,
    };
  });
}

export async function resumePendingCoordinationSignalDeliveries(
  dependencies: CoordinationSignalDependencies,
): Promise<() => void> {
  return deliveryChannelFor(dependencies).resumePendingDeliveries();
}

export async function resolveCoordinationSignal(
  dependencies: CoordinationSignalDependencies,
  input: {
    targetAgentId: string;
    signalId: string;
    resolution: CoordinationSignalResolution;
    note?: string;
  },
): Promise<CoordinationSignal> {
  return updateCoordinationRecord(dependencies, input.targetAgentId, (record) => {
    const signals = record.coordinationSignals ?? [];
    const index = signals.findIndex((signal) => signal.id === input.signalId);
    if (index < 0) {
      throw new Error(
        `Coordination signal ${input.signalId} not found for agent ${input.targetAgentId}`,
      );
    }
    const current = signals[index];
    if (current.status !== "pending") {
      if (current.status === input.resolution && current.resolutionNote === input.note) {
        return { record, result: current };
      }
      throw new Error(`Coordination signal ${input.signalId} is already ${current.status}`);
    }
    const resolved: CoordinationSignal = {
      ...current,
      status: input.resolution,
      resolvedAt: new Date().toISOString(),
      ...(input.note ? { resolutionNote: input.note } : {}),
    };
    const nextSignals = [...signals];
    nextSignals[index] = resolved;
    return {
      record: { ...record, coordinationSignals: nextSignals },
      result: resolved,
    };
  });
}
