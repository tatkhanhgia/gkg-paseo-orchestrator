import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

/**
 * Shared "durable pending item on a StoredAgentRecord, delivered at a safe
 * boundary" primitive. `coordination-signals.ts` and `finish-notification.ts`
 * both persist small queues of not-yet-delivered items on an agent record and
 * only dispatch them when the recipient has no in-flight run. This module
 * owns the two mechanics that are otherwise easy to duplicate incorrectly:
 * serialized read-modify-write per agent record, and idle-gated delivery with
 * bounded in-process retry plus daemon-restart resume.
 *
 * A successful `deliver()` call means the send was dispatched without the
 * transport throwing — it is NOT proof the recipient process executed the
 * turn, read the content, or accepted its disposition. Callers must not
 * treat `markDelivered` as acceptance evidence.
 */

export type SerializedRecordMutator<TResult> = (record: StoredAgentRecord) => {
  record: StoredAgentRecord;
  result: TResult;
  /** Set false when the mutation found no durable state change. */
  changed?: boolean;
};

export interface SerializedRecordUpdateDependencies {
  agentStorage: Pick<AgentStorage, "get" | "upsert">;
  agentManager: Pick<AgentManager, "notifyAgentState">;
}

export type UpdateRecordFn = <TResult>(
  agentId: string,
  mutate: SerializedRecordMutator<TResult>,
) => Promise<TResult>;

export interface PendingDeliveryDispatchResult {
  /** Items for which the transport call returned without throwing. */
  dispatchedIds: readonly string[];
  /** Items intentionally discarded because their authority/ownership is stale. */
  dropped?: readonly { id: string; reason: string }[];
}

// Keyed by the AgentStorage instance, NOT per call to
// createSerializedRecordUpdateQueue. Every consumer of this primitive
// (coordination-signals.ts, finish-notification.ts, and any future caller)
// must serialize read-modify-write on the SAME record through the SAME
// per-agentId promise chain: a caller's StoredAgentRecord carries
// coordinationSignals, finishNotificationDeliveries, and eventPolicyStates
// side by side, so two independently-built queues for the identical
// underlying storage could each read the record, mutate a different field,
// and upsert — silently clobbering whichever wrote second. Sharing identity
// here (not just sharing the implementation) is what actually prevents that.
const sharedUpdateQueueByStorage = new WeakMap<object, { updateRecord: UpdateRecordFn }>();

/**
 * One promise chain per agentId so concurrent writers of durable
 * pending/delivered state on the same record never race a read-modify-write
 * against each other.
 */
export function createSerializedRecordUpdateQueue(
  dependencies: SerializedRecordUpdateDependencies,
): { updateRecord: UpdateRecordFn } {
  const storageKey = dependencies.agentStorage as unknown as object;
  const cached = sharedUpdateQueueByStorage.get(storageKey);
  if (cached) return cached;

  const recordUpdates = new Map<string, Promise<unknown>>();

  const updateRecord: UpdateRecordFn = async (agentId, mutate) => {
    const previous = recordUpdates.get(agentId) ?? Promise.resolve();
    const current = previous.then(async () => {
      const record = await dependencies.agentStorage.get(agentId);
      if (!record || record.internal || record.archivedAt) {
        throw new Error(`Agent ${agentId} is not available for coordinated delivery`);
      }
      const next = mutate(record);
      // A re-entrant state notification can invoke the same observer while its
      // durable receipt is already present. Treat an explicit no-op, or the
      // unchanged record identity used by existing idempotent mutators, as a
      // completed read without another upsert/notification.
      if (next.changed === false || next.record === record) {
        return next.result;
      }
      await dependencies.agentStorage.upsert(next.record);
      dependencies.agentManager.notifyAgentState(agentId);
      return next.result;
    });
    const settledTail = current.then(
      () => undefined,
      () => undefined,
    );
    recordUpdates.set(agentId, settledTail);
    try {
      return await current;
    } finally {
      if (recordUpdates.get(agentId) === settledTail) {
        recordUpdates.delete(agentId);
      }
    }
  };

  const queue = { updateRecord };
  sharedUpdateQueueByStorage.set(storageKey, queue);
  return queue;
}

export interface PendingDeliveryChannelConfig<TItem> {
  /** Used only in log lines to distinguish channels sharing this module. */
  channelName: string;
  getPending(record: StoredAgentRecord): TItem[];
  itemId(item: TItem): string;
  /** Dispatch only. Does not prove provider execution or recipient acceptance. */
  deliver(agentId: string, items: TItem[]): Promise<PendingDeliveryDispatchResult>;
  markDelivered(
    updateRecord: UpdateRecordFn,
    agentId: string,
    deliveredIds: ReadonlySet<string>,
    deliveredAt: string,
  ): Promise<void>;
  markDropped?(
    updateRecord: UpdateRecordFn,
    agentId: string,
    drops: readonly { id: string; reason: string }[],
    droppedAt: string,
  ): Promise<void>;
  markFailed?(
    updateRecord: UpdateRecordFn,
    agentId: string,
    itemIds: ReadonlySet<string>,
    error: string,
  ): Promise<void>;
  /** Bounded in-process retries after a failed dispatch. Default 3. */
  maxInProcessRetries?: number;
  /** Backoff before retry attempt N (1-indexed). Default capped exponential. */
  retryBackoffMs?: (attempt: number) => number;
}

export interface PendingDeliveryChannelDependencies {
  agentManager: Pick<AgentManager, "getAgent" | "hasInFlightRun" | "subscribe">;
  agentStorage: Pick<AgentStorage, "get" | "list">;
  logger: Logger;
}

export interface PendingDeliveryChannel {
  /** Idempotent: subscribes at most once per agentId, then attempts delivery immediately. */
  scheduleDelivery(agentId: string): void;
  /** Bootstrap resume: re-attach delivery watchers for every record with undelivered items. */
  resumePendingDeliveries(): Promise<() => void>;
}

const DEFAULT_MAX_RETRIES = 3;
const defaultBackoffMs = (attempt: number): number => Math.min(500 * 2 ** (attempt - 1), 5_000);

export function createPendingDeliveryChannel<TItem>(
  dependencies: PendingDeliveryChannelDependencies,
  updateRecord: UpdateRecordFn,
  config: PendingDeliveryChannelConfig<TItem>,
): PendingDeliveryChannel {
  const scheduledSubscriptions = new Map<string, () => void>();
  const deliveryInFlight = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();
  const maxRetries = config.maxInProcessRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = config.retryBackoffMs ?? defaultBackoffMs;

  function clearRetryTimer(agentId: string): void {
    const timer = retryTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(agentId);
    }
  }

  function stopWatching(agentId: string): void {
    scheduledSubscriptions.get(agentId)?.();
    scheduledSubscriptions.delete(agentId);
    clearRetryTimer(agentId);
    retryAttempts.delete(agentId);
  }

  async function tryDeliver(agentId: string): Promise<void> {
    if (deliveryInFlight.has(agentId) || dependencies.agentManager.hasInFlightRun(agentId)) {
      return;
    }
    deliveryInFlight.add(agentId);
    try {
      const record = await dependencies.agentStorage.get(agentId);
      const pending = record ? config.getPending(record) : [];
      if (pending.length === 0) {
        stopWatching(agentId);
        return;
      }
      // Re-check after the storage read: a run may have started while we awaited it.
      if (dependencies.agentManager.hasInFlightRun(agentId)) {
        return;
      }
      const outcome = await config.deliver(agentId, pending);
      const pendingIds = new Set(pending.map((item) => config.itemId(item)));
      const dispatchedIds = new Set(
        outcome.dispatchedIds.filter((itemId) => pendingIds.has(itemId)),
      );
      const deliveredAt = new Date().toISOString();
      if (dispatchedIds.size > 0) {
        await config.markDelivered(updateRecord, agentId, dispatchedIds, deliveredAt);
      }
      const dropped = (outcome.dropped ?? []).filter(({ id }) => pendingIds.has(id));
      if (dropped.length > 0 && config.markDropped) {
        await config.markDropped(updateRecord, agentId, dropped, deliveredAt);
      }
      retryAttempts.delete(agentId);
      clearRetryTimer(agentId);
    } catch (error) {
      dependencies.logger.warn(
        { err: error, agentId, channel: config.channelName },
        `Failed to deliver pending ${config.channelName} items`,
      );
      if (config.markFailed) {
        try {
          const record = await dependencies.agentStorage.get(agentId);
          const pending = record ? config.getPending(record) : [];
          await config.markFailed(
            updateRecord,
            agentId,
            new Set(pending.map((item) => config.itemId(item))),
            error instanceof Error ? error.message : String(error),
          );
        } catch (markError) {
          dependencies.logger.warn(
            { err: markError, agentId, channel: config.channelName },
            `Failed to persist ${config.channelName} delivery failure state`,
          );
        }
      }
      // Waiting only for the next idle agent_state event can strand a pending
      // item forever if the recipient is already idle and never transitions
      // again. Pair the event-driven trigger with a bounded local retry so a
      // transient send failure recovers without a new event or a poller.
      const attempt = (retryAttempts.get(agentId) ?? 0) + 1;
      retryAttempts.set(agentId, attempt);
      if (attempt <= maxRetries) {
        clearRetryTimer(agentId);
        const timer = setTimeout(() => {
          retryTimers.delete(agentId);
          void tryDeliver(agentId);
        }, backoffMs(attempt));
        retryTimers.set(agentId, timer);
      }
    } finally {
      deliveryInFlight.delete(agentId);
    }
  }

  function scheduleDelivery(agentId: string): void {
    if (!scheduledSubscriptions.has(agentId)) {
      const unsubscribe = dependencies.agentManager.subscribe(
        (event) => {
          if (event.type === "agent_state" && event.agent.lifecycle === "idle") {
            void tryDeliver(agentId);
          }
        },
        { agentId, replayState: false },
      );
      scheduledSubscriptions.set(agentId, unsubscribe);
    }
    void tryDeliver(agentId);
  }

  async function resumePendingDeliveries(): Promise<() => void> {
    const scheduledAgentIds: string[] = [];
    for (const record of await dependencies.agentStorage.list()) {
      if (config.getPending(record).length === 0) continue;
      scheduledAgentIds.push(record.id);
      scheduleDelivery(record.id);
    }
    return () => {
      for (const agentId of scheduledAgentIds) {
        stopWatching(agentId);
      }
    };
  }

  return { scheduleDelivery, resumePendingDeliveries };
}
