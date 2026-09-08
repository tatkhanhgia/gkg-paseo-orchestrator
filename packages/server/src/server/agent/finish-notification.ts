import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type {
  AgentStorage,
  FinishNotificationDelivery,
  FinishNotificationPendingTerminalDetection,
  FinishNotificationReason,
  FinishNotificationWatch,
  StoredAgentRecord,
} from "./agent-storage.js";
import {
  createPendingDeliveryChannel,
  createSerializedRecordUpdateQueue,
  type PendingDeliveryDispatchResult,
  type UpdateRecordFn,
} from "./coordinated-delivery.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent-prompt.js";
import { hasReleasedAgentWriteLease } from "./lead-handoffs.js";
import { ASSIGNMENT_CONTRACT_EXPIRED_ERROR } from "./role-binding.js";
import {
  resolveFinishNotificationContent,
  type FinishNotificationCouncilSeatLookup,
} from "../policy/bundled/slp/finish-notification-policy.js";

/**
 * Durable, run-correlated replacement for the old RAM-only finish
 * notification subscription. See docs/research/2026-09-06-maestro-slp-adoption-xia-deep.md#G1
 * for the failure modes this closes: a subscription torn down before a
 * failed send retries, a fast child finishing before the watcher attaches,
 * and duplicate deliveries when more than one caller/call-site watches the
 * same run.
 *
 * Two ledgers live on StoredAgentRecord (see agent-storage.ts):
 *  - `finishNotificationWatches` on the CHILD being watched — the durable
 *    intent, persisted before launch by callers that can (see
 *    `registerFinishNotificationWatch`).
 *  - `finishNotificationDeliveries` on the CALLER (recipient) — the dedup +
 *    dispatch ledger, gated on the caller's own idle state exactly like
 *    `coordination-signals.ts`'s pending signals.
 */

export interface FinishNotificationDependencies {
  // Full types, not a Pick: delivery dispatches through `sendPromptToAgent`,
  // which needs the whole surface (mode changes, run start, unarchive).
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  /**
   * Integration dependency: resolves the canonical Council seat projection
   * for a finishing child, if any. Missing or failing resolution is always
   * `unknown` and therefore content-redacted; only the canonical resolver may
   * return `not_council`.
   */
  resolveCouncilSeatProjection?: (
    childAgentId: string,
  ) => Promise<FinishNotificationCouncilSeatLookup>;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
  resolveCouncilSeatProjection?: (
    childAgentId: string,
  ) => Promise<FinishNotificationCouncilSeatLookup>;
}

// Keyed by the AgentStorage singleton, NOT by the `dependencies` wrapper
// object. `setupFinishNotification` is called independently from more than
// one call site (create-agent, and mid-run notifyOnFinish in paseo-tools.ts)
// and each call builds its own `dependencies` literal; if the queue/channel
// were cached per-literal, two independent calls watching the same run would
// each get their own uncoordinated delivery channel and could both drain
// (and double-send) the same durable pending item before either marked it
// delivered. Every call site passes the same live AgentStorage instance, so
// keying on it gives one real queue/channel per daemon process.
const updateRecordByStorage = new WeakMap<AgentStorage, UpdateRecordFn>();
const deliveryChannelByStorage = new WeakMap<
  AgentStorage,
  ReturnType<typeof createPendingDeliveryChannel<FinishNotificationDelivery>>
>();

function updateRecordFor(dependencies: FinishNotificationDependencies): UpdateRecordFn {
  let updateRecord = updateRecordByStorage.get(dependencies.agentStorage);
  if (!updateRecord) {
    updateRecord = createSerializedRecordUpdateQueue(dependencies).updateRecord;
    updateRecordByStorage.set(dependencies.agentStorage, updateRecord);
  }
  return updateRecord;
}

async function resolveCouncilSeat(
  dependencies: FinishNotificationDependencies,
  childAgentId: string,
): Promise<FinishNotificationCouncilSeatLookup> {
  if (!dependencies.resolveCouncilSeatProjection) {
    dependencies.logger.warn(
      { childAgentId },
      "resolveCouncilSeatProjection is not wired: finish notification content is withheld",
    );
    return { status: "unknown" };
  }
  try {
    return await dependencies.resolveCouncilSeatProjection(childAgentId);
  } catch (error) {
    dependencies.logger.warn(
      { err: error, childAgentId },
      "Council seat lookup failed for finish notification; failing closed",
    );
    return { status: "unknown" };
  }
}

function callerAssignmentDispatchDropReason(record: StoredAgentRecord | null): string | null {
  const assignment =
    record?.roleBinding?.assignmentContract?.receipt ?? record?.roleBinding?.assignment;
  if (!assignment?.expiresAt) return null;
  const expiresAt = Date.parse(assignment.expiresAt);
  if (!Number.isFinite(expiresAt)) return "caller-assignment-expiry-unreadable";
  return expiresAt <= Date.now() ? "caller-assignment-expired-at-dispatch" : null;
}

function callerDispatchDropReason(record: StoredAgentRecord | null): string | null {
  if (!record || record.archivedAt || record.internal) {
    return "caller-unavailable-at-dispatch";
  }
  if (hasReleasedAgentWriteLease(record)) {
    return "caller-unavailable-or-write-lease-released";
  }
  return callerAssignmentDispatchDropReason(record);
}

function hasAssignmentExpiryErrorPrefix(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith(`${ASSIGNMENT_CONTRACT_EXPIRED_ERROR}:`)
  );
}

async function deliverPendingFinishNotifications(
  dependencies: FinishNotificationDependencies,
  callerAgentId: string,
  deliveries: readonly FinishNotificationDelivery[],
): Promise<PendingDeliveryDispatchResult> {
  const callerRecord = await dependencies.agentStorage.get(callerAgentId);
  // `archivedAt`/`internal` catch a detached or removed caller; a released
  // write lease is a distinct condition (see lead-handoffs.ts) — the
  // caller's identity is still live, but a successor now holds write
  // ownership for its scope. `sendPromptToAgent` below would already throw
  // on this via `assertAgentPromptLease`, but that throw lands AFTER every
  // body in this batch has been built and triggers bounded in-process
  // retries against a condition that will never resolve itself. Checking it
  // here, up front, drops cleanly (like the archived/internal case) instead
  // of retrying a permanently-stale target.
  if (
    !callerRecord ||
    callerRecord.archivedAt ||
    callerRecord.internal ||
    hasReleasedAgentWriteLease(callerRecord)
  ) {
    dependencies.logger.warn(
      { callerAgentId },
      "Dropping pending finish notifications: caller archived/internal/unavailable/write-lease-released at delivery",
    );
    return {
      dispatchedIds: [],
      dropped: deliveries.map((delivery) => ({
        id: delivery.deliveryId,
        reason: "caller-unavailable-or-write-lease-released",
      })),
    };
  }

  const bodies: Array<{ deliveryId: string; body: string }> = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  for (const delivery of deliveries) {
    if (delivery.requireParentOwnership) {
      const childRecord = await dependencies.agentStorage.get(delivery.childAgentId);
      // Parent-label detach and write-lease revocation are distinct: a
      // child's `parent` label can be edited/removed independently of the
      // canonical lead-handoff chain, and a lease release does not always
      // rewrite labels. Both make this specific delivery's attribution
      // stale, so both must gate it.
      if (
        getParentAgentIdFromLabels(childRecord?.labels) !== callerAgentId ||
        hasReleasedAgentWriteLease(childRecord)
      ) {
        dependencies.logger.warn(
          { callerAgentId, childAgentId: delivery.childAgentId, deliveryId: delivery.deliveryId },
          "Dropping finish notification: parent ownership or write lease no longer current at delivery",
        );
        dropped.push({
          id: delivery.deliveryId,
          reason: "child-parent-ownership-or-write-lease-revoked",
        });
        continue;
      }
    }
    const councilSeat = await resolveCouncilSeat(dependencies, delivery.childAgentId);
    bodies.push({
      deliveryId: delivery.deliveryId,
      body: resolveFinishNotificationContent({
        childAgentId: delivery.childAgentId,
        title: delivery.childTitle ?? delivery.childAgentId,
        reason: delivery.reason,
        lastAssistantMessage: delivery.lastAssistantMessage,
        permissionRequest: delivery.permissionRequest ?? undefined,
        councilSeat,
      }),
    });
  }

  if (bodies.length === 0) {
    return { dispatchedIds: [], dropped };
  }

  // Re-read the canonical caller assignment at the last safe point before dispatch. The first
  // record read above protects ordinary unavailable callers, but an assignment may expire while
  // Council content is being resolved. A durable notification must not start a new run after its
  // caller's authority window has closed; record an explicit drop so restart cannot retry it.
  const dispatchCallerRecord = await dependencies.agentStorage.get(callerAgentId);
  const dispatchDropReason = callerDispatchDropReason(dispatchCallerRecord);
  if (dispatchDropReason) {
    return {
      dispatchedIds: [],
      dropped: [
        ...dropped,
        ...bodies.map(({ deliveryId }) => ({ id: deliveryId, reason: dispatchDropReason })),
      ],
    };
  }

  // Never replace or steer an active caller run: the surrounding delivery
  // channel only calls this once the caller has no in-flight run, and
  // `replaceRunning: false` keeps that guarantee even if the caller starts a
  // run in the small window between that check and this call.
  try {
    await sendPromptToAgent({
      agentManager: dependencies.agentManager,
      agentStorage: dependencies.agentStorage,
      agentId: callerAgentId,
      prompt: formatSystemNotificationPrompt(bodies.map(({ body }) => body).join("\n\n")),
      unarchive: false,
      replaceRunning: false,
      waitForRunStart: true,
      logger: dependencies.logger,
    });
  } catch (error) {
    // The error prefix only identifies the manager's expiry-shaped failure for a bounded
    // canonical lookup. Provider/error text is never authority: a caller can remain current
    // while a provider returns the same prefix, which must follow the normal retry path.
    if (!hasAssignmentExpiryErrorPrefix(error)) {
      throw error;
    }
    const canonicalCallerRecord = await dependencies.agentStorage.get(callerAgentId);
    if (
      callerDispatchDropReason(canonicalCallerRecord) !== "caller-assignment-expired-at-dispatch"
    ) {
      throw error;
    }
    return {
      dispatchedIds: [],
      dropped: [
        ...dropped,
        ...bodies.map(({ deliveryId }) => ({
          id: deliveryId,
          reason: "caller-assignment-expired-at-start",
        })),
      ],
    };
  }
  return {
    dispatchedIds: bodies.map(({ deliveryId }) => deliveryId),
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

function deliveryChannelFor(
  dependencies: FinishNotificationDependencies,
): ReturnType<typeof createPendingDeliveryChannel<FinishNotificationDelivery>> {
  // First writer wins: the channel closes over the `dependencies` object
  // (and therefore its logger/resolveCouncilSeatProjection) of whichever
  // call reaches here first for this AgentStorage. Every current call site
  // is expected to pass equivalent dependencies for the same daemon process.
  let channel = deliveryChannelByStorage.get(dependencies.agentStorage);
  if (!channel) {
    channel = createPendingDeliveryChannel(dependencies, updateRecordFor(dependencies), {
      channelName: "finish-notification",
      getPending: (record) =>
        record.internal || record.archivedAt
          ? []
          : (record.finishNotificationDeliveries ?? []).filter(
              (delivery) =>
                (delivery.deliveredAt ?? delivery.dispatchedAt ?? null) === null &&
                (delivery.droppedAt ?? null) === null,
            ),
      itemId: (delivery) => delivery.deliveryId,
      deliver: (callerAgentId, deliveries) =>
        deliverPendingFinishNotifications(dependencies, callerAgentId, deliveries),
      markDelivered: async (updateRecord, callerAgentId, deliveredIds, deliveredAt) => {
        await updateRecord(callerAgentId, (record) => {
          const deliveries = (record.finishNotificationDeliveries ?? []).map((delivery) =>
            deliveredIds.has(delivery.deliveryId) &&
            (delivery.deliveredAt ?? delivery.dispatchedAt ?? null) === null &&
            (delivery.droppedAt ?? null) === null
              ? Object.assign({}, delivery, { deliveredAt, dispatchedAt: deliveredAt })
              : delivery,
          );
          return {
            record: { ...record, finishNotificationDeliveries: deliveries },
            result: undefined,
          };
        });
      },
      markDropped: async (updateRecord, callerAgentId, drops, droppedAt) => {
        await updateRecord(callerAgentId, (record) => {
          const dropById = new Map(drops.map((drop) => [drop.id, drop.reason]));
          const deliveries = (record.finishNotificationDeliveries ?? []).map((delivery) => {
            const reason = dropById.get(delivery.deliveryId);
            if (
              reason === undefined ||
              (delivery.deliveredAt ?? delivery.dispatchedAt ?? null) !== null ||
              (delivery.droppedAt ?? null) !== null
            ) {
              return delivery;
            }
            return Object.assign({}, delivery, { droppedAt, dropReason: reason });
          });
          return {
            record: { ...record, finishNotificationDeliveries: deliveries },
            result: undefined,
          };
        });
      },
      markFailed: async (updateRecord, callerAgentId, itemIds, error) => {
        await updateRecord(callerAgentId, (record) => {
          const deliveries = (record.finishNotificationDeliveries ?? []).map((delivery) =>
            itemIds.has(delivery.deliveryId) &&
            (delivery.deliveredAt ?? delivery.dispatchedAt ?? null) === null &&
            (delivery.droppedAt ?? null) === null
              ? Object.assign({}, delivery, { attempts: delivery.attempts + 1, lastError: error })
              : delivery,
          );
          return {
            record: { ...record, finishNotificationDeliveries: deliveries },
            result: undefined,
          };
        });
      },
    });
    deliveryChannelByStorage.set(dependencies.agentStorage, channel);
  }
  return channel;
}

function computeDeliveryId(input: {
  childAgentId: string;
  runId: string;
  runStartedAt: string;
  callerAgentId: string;
  reason: FinishNotificationReason;
  permissionRequestId: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.childAgentId,
        input.runId,
        input.runStartedAt,
        input.callerAgentId,
        input.reason,
        input.permissionRequestId ?? "",
      ]),
    )
    .digest("hex");
}

interface RecordFinishNotificationEventInput {
  watch: FinishNotificationWatch;
  childAgentId: string;
  runId: string;
  runStartedAt: string;
  reason: FinishNotificationReason;
  childTitle: string | null;
  lastAssistantMessage: string | null;
  permissionRequest: FinishNotificationDelivery["permissionRequest"];
  /**
   * The moment the outcome was actually witnessed, when known ahead of this
   * write (e.g. replayed from a durable `pendingTerminalDetection` receipt
   * captured before a crash). Defaults to now for the live-detection path,
   * where this write IS the first durable record of the event.
   */
  detectedAt?: string;
}

/**
 * Durably records a detected terminal/permission event, deduped by
 * (child, run, caller, reason[, permission]) so two independent watchers on
 * the same run collapse into one delivery. Cross-record write: the watch
 * lives on the child, the delivery ledger lives on the caller (recipient).
 */
async function recordFinishNotificationEvent(
  dependencies: FinishNotificationDependencies,
  input: RecordFinishNotificationEventInput,
): Promise<void> {
  const permissionRequestId = input.permissionRequest?.id ?? null;
  const deliveryId = computeDeliveryId({
    childAgentId: input.childAgentId,
    runId: input.runId,
    runStartedAt: input.runStartedAt,
    callerAgentId: input.watch.callerAgentId,
    reason: input.reason,
    permissionRequestId,
  });
  const updateRecord = updateRecordFor(dependencies);
  await updateRecord(input.watch.callerAgentId, (record) => {
    const existing = record.finishNotificationDeliveries ?? [];
    if (existing.some((delivery) => delivery.deliveryId === deliveryId)) {
      return { record, result: undefined };
    }
    const created: FinishNotificationDelivery = {
      deliveryId,
      watchId: input.watch.watchId,
      childAgentId: input.childAgentId,
      callerAgentId: input.watch.callerAgentId,
      runId: input.runId,
      runStartedAt: input.runStartedAt,
      reason: input.reason,
      requireParentOwnership: input.watch.requireParentOwnership,
      childTitle: input.childTitle,
      lastAssistantMessage: input.lastAssistantMessage,
      permissionRequest: input.permissionRequest,
      detectedAt: input.detectedAt ?? new Date().toISOString(),
      deliveredAt: null,
      attempts: 0,
      lastError: null,
    };
    return {
      record: { ...record, finishNotificationDeliveries: [...existing, created] },
      result: undefined,
    };
  });
  deliveryChannelFor(dependencies).scheduleDelivery(input.watch.callerAgentId);
}

async function markWatchStopped(
  dependencies: FinishNotificationDependencies,
  childAgentId: string,
  watchId: string,
): Promise<void> {
  const updateRecord = updateRecordFor(dependencies);
  await updateRecord(childAgentId, (record) => {
    const watches = (record.finishNotificationWatches ?? []).map((watch) =>
      watch.watchId === watchId ? Object.assign({}, watch, { status: "stopped" as const }) : watch,
    );
    // The write-ahead receipt (if any) has now either been replayed into a
    // durable caller-side delivery or was never needed; either way it must
    // not linger for a future resume to try to replay again.
    const pendingTerminalDetections = (
      record.finishNotificationPendingTerminalDetections ?? []
    ).filter((detection) => detection.watchId !== watchId);
    return {
      record: {
        ...record,
        finishNotificationWatches: watches,
        finishNotificationPendingTerminalDetections: pendingTerminalDetections,
      },
      result: undefined,
    };
  });
}

/**
 * Write-ahead step for a terminal detection: persists the reason and the
 * exact fields the eventual caller-side delivery needs, on the CHILD's own
 * watch record, BEFORE the cross-record write to the caller. A crash after
 * this write but before `recordFinishNotificationEvent` completes leaves
 * durable evidence resume can replay without re-observing the provider (see
 * `resumePendingFinishNotificationDeliveries`). Never called for "needs
 * permission": that reason is not terminal and never retires the watch.
 *
 * The write is conditional on the CURRENT persisted watch, read fresh inside
 * this same record-update transaction, still being `active` and still
 * correlating with the exact run this detection is about (`expectedRun`).
 * If the watch was concurrently cancelled/stopped (e.g. `cancelFinishNotificationWatch`
 * racing an in-flight detection) or now belongs to a different run, this
 * returns `false` and writes nothing — a stopped or mismatched watch must
 * never be resurrected into a caller-facing delivery.
 */
async function persistPendingTerminalDetection(
  dependencies: FinishNotificationDependencies,
  childAgentId: string,
  watchId: string,
  expectedRun: { runId: string; runStartedAt: string },
  detection: FinishNotificationPendingTerminalDetection,
): Promise<boolean> {
  const updateRecord = updateRecordFor(dependencies);
  return updateRecord(childAgentId, (record) => {
    const current = (record.finishNotificationWatches ?? []).find(
      (watch) => watch.watchId === watchId,
    );
    if (
      !current ||
      current.status !== "active" ||
      (current.observedRunId ?? null) !== expectedRun.runId ||
      (current.observedRunStartedAt ?? null) !== expectedRun.runStartedAt
    ) {
      return { record, result: false };
    }
    const pendingTerminalDetections = [
      ...(record.finishNotificationPendingTerminalDetections ?? []).filter(
        (existing) => existing.watchId !== watchId,
      ),
      detection,
    ];
    return {
      record: { ...record, finishNotificationPendingTerminalDetections: pendingTerminalDetections },
      result: true,
    };
  });
}

/**
 * For a watch that was registered before launch but whose run never
 * actually started (e.g. the initial prompt dispatch failed): mark it
 * stopped without ever attaching a watcher, so it isn't left "active"
 * forever and doesn't get picked up by daemon-restart resume.
 */
export async function cancelFinishNotificationWatch(
  dependencies: FinishNotificationDependencies,
  params: { childAgentId: string; watch: FinishNotificationWatch },
): Promise<void> {
  await markWatchStopped(dependencies, params.childAgentId, params.watch.watchId);
}

/**
 * Persists the intent to notify `callerAgentId` about `childAgentId`'s next
 * run outcome. Callers that control launch ordering (create-agent) MUST call
 * this BEFORE dispatching the initial prompt so a crash between registration
 * and the first observed event still leaves durable evidence of the intent.
 */
export async function registerFinishNotificationWatch(
  dependencies: FinishNotificationDependencies,
  params: { childAgentId: string; callerAgentId: string; requireParentOwnership?: boolean },
): Promise<FinishNotificationWatch> {
  const requireParentOwnership = params.requireParentOwnership ?? false;
  const updateRecord = updateRecordFor(dependencies);
  return updateRecord(params.childAgentId, (record) => {
    // A watch that has already durably observed a started run belongs to that
    // run. Never reuse it for a later launch: the new launch needs a fresh
    // durable identity, otherwise a fast finish could be deduped against the
    // prior run. Watches without an observed run can safely be reused while
    // the pre-launch intent is still pending.
    const existing = (record.finishNotificationWatches ?? []).find(
      (watch) =>
        watch.status === "active" &&
        watch.callerAgentId === params.callerAgentId &&
        watch.requireParentOwnership === requireParentOwnership &&
        (watch.observedRunId ?? null) === null,
    );
    if (existing) {
      return { record, result: existing };
    }
    const watch: FinishNotificationWatch = {
      watchId: randomUUID(),
      callerAgentId: params.callerAgentId,
      requireParentOwnership,
      launchToken: randomUUID(),
      registeredAt: new Date().toISOString(),
      status: "active",
    };
    return {
      record: {
        ...record,
        finishNotificationWatches: [...(record.finishNotificationWatches ?? []), watch],
      },
      result: watch,
    };
  });
}

function reasonForLifecycle(agent: ManagedAgent): FinishNotificationReason | null {
  if (agent.lifecycle === "error") return "errored";
  if (agent.lifecycle === "closed") return "was closed";
  return null;
}

function runReceiptForAgent(agent: ManagedAgent): { runId: string; startedAt: string } | null {
  if (agent.lifecycle !== "running") return null;
  const runId = agent.activeForegroundTurnId ?? agent.activeTurnId;
  const startedAt = agent.activeTurnStartedAt?.toISOString() ?? null;
  return runId && startedAt ? { runId, startedAt } : null;
}

async function persistObservedRun(
  dependencies: FinishNotificationDependencies,
  childAgentId: string,
  watchId: string,
  receipt: { runId: string; startedAt: string },
): Promise<void> {
  await updateRecordFor(dependencies)(childAgentId, (record) => {
    let changed = false;
    const watches = (record.finishNotificationWatches ?? []).map((watch) => {
      if (watch.watchId !== watchId || watch.status !== "active") return watch;
      const existingRunId = watch.observedRunId ?? null;
      const existingStartedAt = watch.observedRunStartedAt ?? null;
      if (existingRunId !== null && existingRunId !== receipt.runId) return watch;
      if (existingStartedAt !== null && existingStartedAt !== receipt.startedAt) return watch;
      if (existingRunId === receipt.runId && existingStartedAt === receipt.startedAt) {
        return watch;
      }
      changed = true;
      return Object.assign({}, watch, {
        observedRunId: receipt.runId,
        observedRunStartedAt: receipt.startedAt,
      });
    });
    return changed
      ? { record: { ...record, finishNotificationWatches: watches }, result: undefined }
      : { record, result: undefined, changed: false };
  });
}

/**
 * Attaches the live watcher for a previously registered watch and reconciles
 * against the child's current snapshot. A terminal snapshot is actionable
 * only after this watch has BOTH a durable started-run receipt AND a live
 * "running" observation made during this attach's own lifetime; an idle
 * snapshot before that point remains UNKNOWN, whether that is a prelaunch
 * crash or a lazy-bootstrap reload whose first snapshot cannot prove the
 * watched run's real fate. Callers that can control launch ordering attach
 * before dispatch, while legacy dispatch-first callers still benefit from
 * the same receipt check. This closes the fast-finish race without
 * synthesizing completion from a prelaunch crash or a restart.
 */
export function attachFinishNotificationWatch(
  dependencies: FinishNotificationDependencies,
  params: { childAgentId: string; watch: FinishNotificationWatch },
): () => void {
  const { childAgentId, watch } = params;
  let observedRunId = watch.observedRunId ?? null;
  let observedRunStartedAt = watch.observedRunStartedAt ?? null;
  // A persisted started-run receipt alone must NEVER arm terminal detection.
  // It proves a run started at some point in the past; it does not prove
  // THIS attach lifetime has genuinely witnessed that run in progress. After
  // a lazy-bootstrap reload/restart, the very first snapshot this process
  // sees for the child can be a default/reconciled "idle" that carries no
  // evidence the watched run actually reached that state — treating it as
  // terminal would be exactly the "idle = finished" fabrication this module
  // must not do. `hasSeenRunning` is therefore only ever armed below by a
  // LIVE "running" observation made during this attach's own lifetime
  // (the fast-path snapshot check right after subscribing, or a later
  // agent_state/agent_stream event) — never restored from the watch record.
  let hasSeenRunning = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let stopped = false;

  // Resolves `true` only when a caller-facing delivery was durably recorded
  // (or, for a non-terminal permission ping, always once the write below
  // completes without throwing). `detectSafely` must retire the watch
  // (`markWatchStopped`) only when this is `true` — a `false` result (no
  // durable started-run receipt, or `persistPendingTerminalDetection`
  // refused because the watch is no longer active/no longer correlates with
  // this exact run) means nothing was recorded, so the watch's actual
  // current state — whatever it durably is — must be left untouched.
  async function detect(
    reason: FinishNotificationReason,
    terminal: boolean,
    permissionRequest?: FinishNotificationDelivery["permissionRequest"],
  ): Promise<boolean> {
    if (!observedRunId || !observedRunStartedAt) {
      dependencies.logger.warn(
        { childAgentId, callerAgentId: watch.callerAgentId, reason },
        "Finish notification outcome lacks a durable started-run receipt; leaving watch active",
      );
      return false;
    }
    const record = await dependencies.agentStorage.get(childAgentId);
    const lastAssistantMessage =
      await dependencies.agentManager.getLastAssistantMessage(childAgentId);
    const childTitle = record?.title ?? null;
    let detectedAt: string | undefined;
    if (terminal) {
      if (reason === "needs permission") {
        throw new Error("finish-notification: 'needs permission' is not a terminal reason");
      }
      detectedAt = new Date().toISOString();
      // Write-ahead: persist the terminal receipt on the CHILD's own watch
      // record BEFORE the cross-record write below. A crash between the two
      // leaves this durable, so resume can replay the delivery without
      // re-observing the provider (see resumePendingFinishNotificationDeliveries).
      // Conditional on the watch still being active and still correlating
      // with this exact run: a concurrent cancel/stop or a stale run must
      // never be resurrected into a caller-facing delivery.
      const accepted = await persistPendingTerminalDetection(
        dependencies,
        childAgentId,
        watch.watchId,
        { runId: observedRunId, runStartedAt: observedRunStartedAt },
        {
          watchId: watch.watchId,
          reason,
          runId: observedRunId,
          runStartedAt: observedRunStartedAt,
          detectedAt,
          childTitle,
          lastAssistantMessage,
        },
      );
      if (!accepted) {
        dependencies.logger.warn(
          { childAgentId, callerAgentId: watch.callerAgentId, watchId: watch.watchId, reason },
          "Watch is no longer active or no longer correlates with the observed run; not recording a caller delivery",
        );
        return false;
      }
    }
    await recordFinishNotificationEvent(dependencies, {
      watch,
      childAgentId,
      runId: observedRunId,
      runStartedAt: observedRunStartedAt,
      reason,
      childTitle,
      lastAssistantMessage,
      permissionRequest: permissionRequest ?? null,
      detectedAt,
    });
    return true;
  }

  function detectSafely(
    reason: FinishNotificationReason,
    options: {
      terminal?: boolean;
      permissionRequest?: FinishNotificationDelivery["permissionRequest"];
    } = {},
  ): void {
    if (stopped) return;
    const terminal = options.terminal ?? true;
    if (!observedRunId || !observedRunStartedAt || (terminal && !hasSeenRunning)) {
      dependencies.logger.debug(
        { childAgentId, callerAgentId: watch.callerAgentId, reason, terminal },
        "Ignoring finish-notification lifecycle evidence without an observed started run",
      );
      return;
    }
    // Ordering matters for durability. Unsubscribing is cheap, synchronous,
    // and always safe to do immediately: it only stops THIS in-process
    // watcher from seeing more events, so it never double-detects. Marking
    // `watch.status = "stopped"` is different — once that write lands,
    // daemon-restart resume will never re-attach this watch again. If that
    // persisted BEFORE the durable delivery record (recordFinishNotificationEvent)
    // succeeded, a crash or storage-write failure in between would strand a
    // detected terminal/permission event with no watch left to retry it and
    // no delivery ever recorded — permanently lost. So the durable record
    // write must complete first; only on its success do we retire the watch.
    // If it fails, the watch is left "active" in storage (though this
    // in-process instance stops listening) so a later resume can retry.
    if (terminal) {
      stopped = true;
      unsubscribe();
    }
    void detect(reason, terminal, options.permissionRequest)
      .then(async (recorded) => {
        if (terminal && recorded) {
          await markWatchStopped(dependencies, childAgentId, watch.watchId);
        }
        return undefined;
      })
      .catch((error) => {
        dependencies.logger.error(
          { err: error, childAgentId, callerAgentId: watch.callerAgentId, reason },
          "Failed to record finish notification event",
        );
      });
  }

  function observeRunningAgent(agent: ManagedAgent): void {
    const receipt = runReceiptForAgent(agent);
    if (!receipt) return;
    if (
      observedRunId !== null &&
      (observedRunId !== receipt.runId ||
        (observedRunStartedAt !== null && observedRunStartedAt !== receipt.startedAt))
    ) {
      return;
    }
    observedRunId = receipt.runId;
    observedRunStartedAt = receipt.startedAt;
    hasSeenRunning = agent.pendingPermissions.size === 0;
    void persistObservedRun(dependencies, childAgentId, watch.watchId, receipt).catch((error) => {
      dependencies.logger.warn(
        { err: error, childAgentId, watchId: watch.watchId },
        "Failed to persist observed finish-notification run receipt",
      );
    });
  }

  function handleAgentStateEvent(agent: ManagedAgent): void {
    for (const requestId of notifiedPermissionRequestIds) {
      if (!agent.pendingPermissions.has(requestId)) {
        notifiedPermissionRequestIds.delete(requestId);
      }
    }
    if (agent.lifecycle === "running") {
      observeRunningAgent(agent);
      return;
    }
    const reason = reasonForLifecycle(agent);
    if (reason === "errored" && hasSeenRunning) {
      detectSafely("errored");
      return;
    }
    if (agent.lifecycle === "idle" && hasSeenRunning) {
      detectSafely("finished");
      return;
    }
    if (reason === "was closed" && hasSeenRunning) {
      detectSafely("was closed");
    }
  }

  function handleAgentStreamEvent(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
  ): void {
    if (event.event.type === "permission_requested") {
      // A permission pause is an intermediate checkpoint, not a run's
      // terminal outcome: forget the run observed before it so a later
      // idle during follow-up startup cannot masquerade as completion.
      if (!observedRunId || !observedRunStartedAt) return;
      hasSeenRunning = false;
      if (notifiedPermissionRequestIds.has(event.event.request.id)) return;
      notifiedPermissionRequestIds.add(event.event.request.id);
      detectSafely("needs permission", {
        terminal: false,
        permissionRequest: {
          id: event.event.request.id,
          provider: event.event.request.provider,
          kind: event.event.request.kind,
          name: event.event.request.name,
          description: event.event.request.description ?? null,
          input: event.event.request.input ?? null,
        },
      });
      return;
    }

    if (event.event.type === "permission_resolved") {
      notifiedPermissionRequestIds.delete(event.event.requestId);
      const childAgent = dependencies.agentManager.getAgent(childAgentId);
      if (childAgent?.pendingPermissions.size === 0) {
        hasSeenRunning =
          childAgent.lifecycle === "running" && Boolean(runReceiptForAgent(childAgent));
      }
    }
  }

  const unsubscribe = dependencies.agentManager.subscribe(
    (event) => {
      if (stopped) return;
      if (event.type === "agent_state") {
        handleAgentStateEvent(event.agent);
        return;
      }
      if (event.type !== "agent_stream") {
        // "provider_subagent" and "agent_closure" carry no `.event` field;
        // only "agent_stream" does. Anything else is not a permission
        // checkpoint this watcher cares about.
        return;
      }
      handleAgentStreamEvent(event);
    },
    { agentId: childAgentId, replayState: false },
  );

  // Fast-finish reconciliation: the caller already dispatched (or attempted
  // to dispatch) a run before calling this, so a terminal-looking snapshot
  // here may reflect a run that already finished — but whether it is a
  // genuine outcome still depends on `hasSeenRunning` below, not on the
  // snapshot alone.
  const childSnapshot = dependencies.agentManager.getAgent(childAgentId);
  if (!childSnapshot) {
    // A null snapshot only proves the in-memory manager has no RAM entry for
    // this agent right now. That is consistent with lazy bootstrap (not yet
    // loaded), but this call alone cannot rule out a concurrent deletion
    // race either — it stays genuinely UNKNOWN, not "confirmed not loaded".
    // Since retiring the watch here would permanently discard durable
    // intent/observed-run evidence on unproven grounds, leave the watch
    // active and the subscription attached so it reconciles once/if the
    // child loads and emits state; do not call stop(), which would persist
    // status="stopped".
    return unsubscribe;
  }
  if (childSnapshot.lifecycle === "running") {
    observeRunningAgent(childSnapshot);
  } else if (childSnapshot.lifecycle === "error" && hasSeenRunning) {
    detectSafely("errored");
  } else if (childSnapshot.lifecycle === "closed") {
    if (hasSeenRunning) detectSafely("was closed");
  } else if (childSnapshot.lifecycle === "idle") {
    // An idle snapshot alone cannot distinguish a pre-launch crash from a
    // fast completed run. Only a live "running" observation witnessed during
    // this attach's own lifetime (`hasSeenRunning`) authorizes a finish
    // notification — a persisted observed-run receipt alone never does.
    if (hasSeenRunning) detectSafely("finished");
  }

  return unsubscribe;
}

/**
 * Convenience composition for callers that dispatch a prompt and only then
 * attach a watcher (the current shape of every existing call site). Prefer
 * `registerFinishNotificationWatch` before launch + `attachFinishNotificationWatch`
 * after launch when the call site controls both sides of dispatch.
 */
export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const dependencies: FinishNotificationDependencies = {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
    resolveCouncilSeatProjection: params.resolveCouncilSeatProjection,
  };
  void registerFinishNotificationWatch(dependencies, {
    childAgentId: params.childAgentId,
    callerAgentId: params.callerAgentId,
    requireParentOwnership: params.requireParentOwnership,
  }).then((watch) =>
    attachFinishNotificationWatch(dependencies, { childAgentId: params.childAgentId, watch }),
  );
}

/**
 * Replays a durable write-ahead terminal receipt directly from storage
 * (no provider/manager observation) when it exactly correlates with the
 * watch's own durable observed-run receipt. Returns whether the replay
 * resolved the watch (delivered + stopped); `false` leaves it unresolved
 * for the caller to fall back to live re-attachment.
 */
async function replayPendingTerminalDetection(
  dependencies: FinishNotificationDependencies,
  childAgentId: string,
  watch: FinishNotificationWatch,
  pendingTerminalDetection: FinishNotificationPendingTerminalDetection,
): Promise<boolean> {
  const correlatesWithObservedRun =
    pendingTerminalDetection.runId === (watch.observedRunId ?? null) &&
    pendingTerminalDetection.runStartedAt === (watch.observedRunStartedAt ?? null);
  if (!correlatesWithObservedRun) {
    dependencies.logger.warn(
      { childAgentId, watchId: watch.watchId },
      "Pending terminal detection does not correlate with this watch's observed run; leaving unresolved",
    );
    return false;
  }
  try {
    await recordFinishNotificationEvent(dependencies, {
      watch,
      childAgentId,
      runId: pendingTerminalDetection.runId,
      runStartedAt: pendingTerminalDetection.runStartedAt,
      reason: pendingTerminalDetection.reason,
      childTitle: pendingTerminalDetection.childTitle,
      lastAssistantMessage: pendingTerminalDetection.lastAssistantMessage,
      permissionRequest: null,
      detectedAt: pendingTerminalDetection.detectedAt,
    });
    await markWatchStopped(dependencies, childAgentId, watch.watchId);
    return true;
  } catch (error) {
    dependencies.logger.warn(
      { err: error, childAgentId, watchId: watch.watchId },
      "Failed to replay pending terminal detection; leaving the durable receipt active for a later recovery attempt",
    );
    // Fall through to attach: this instance failed to replay from storage,
    // but a live watcher can still observe/retry.
    return false;
  }
}

/**
 * Bootstrap resume: re-attaches watchers for every still-active watch and
 * reschedules delivery for every undelivered notification. Integration
 * dependency — wire this the same way bootstrap.ts already wires
 * `resumePendingCoordinationSignalDeliveries`.
 */
export async function resumePendingFinishNotificationDeliveries(
  dependencies: FinishNotificationDependencies,
): Promise<() => void> {
  const stopDelivery = await deliveryChannelFor(dependencies).resumePendingDeliveries();
  const stopWatches: Array<() => void> = [];
  const allRecords = await dependencies.agentStorage.list();
  // Deliveries are recorded on the CALLER's record (see the module-level
  // doc comment), never on the child being watched. Checking `record` here
  // (the child) always finds zero deliveries and makes this reconciliation
  // a permanent no-op, causing spurious re-attachment of watches whose
  // terminal event was already durably recorded (and possibly delivered)
  // on the caller's side.
  const recordsById = new Map(allRecords.map((record) => [record.id, record]));
  for (const record of allRecords) {
    if (record.internal || record.archivedAt) continue;
    for (const watch of record.finishNotificationWatches ?? []) {
      if (watch.status !== "active") continue;
      const callerRecord = recordsById.get(watch.callerAgentId);
      // A terminal delivery for this exact (child, watch) pair already
      // durably existing on the caller's ledger — delivered, dropped, or
      // still pending dispatch, any of the three — proves the terminal
      // outcome was already captured before whatever crashed. The only
      // thing that could still be missing is the final `markWatchStopped`
      // write on the child's side; reconcile that directly instead of
      // reattaching a live watcher for an event that already happened.
      // Redelivery of a still-pending item is handled by
      // `resumePendingDeliveries` above, not by anything in this loop.
      const existingTerminalDelivery = (callerRecord?.finishNotificationDeliveries ?? []).find(
        (delivery) =>
          delivery.watchId === watch.watchId &&
          delivery.childAgentId === record.id &&
          delivery.reason !== "needs permission" &&
          (watch.observedRunId == null || delivery.runId === watch.observedRunId) &&
          (watch.observedRunStartedAt == null ||
            delivery.runStartedAt === watch.observedRunStartedAt),
      );
      if (existingTerminalDelivery) {
        await markWatchStopped(dependencies, record.id, watch.watchId);
        continue;
      }

      // A durable write-ahead terminal receipt (persisted by `detect()`
      // before its own crash-vulnerable cross-record write) lets resume
      // replay the delivery directly from storage — no provider/manager
      // observation needed. Only ever trusted when it exactly correlates
      // with this watch's own durable observed-run receipt; any mismatch or
      // partial state stays unresolved rather than fabricating completion.
      // Lives in the record's root-level array, keyed by watchId — see the
      // schema comment on FINISH_NOTIFICATION_PENDING_TERMINAL_SCHEMA.
      const pendingTerminalDetection = (
        record.finishNotificationPendingTerminalDetections ?? []
      ).find((detection) => detection.watchId === watch.watchId);
      if (pendingTerminalDetection) {
        const replayed = await replayPendingTerminalDetection(
          dependencies,
          record.id,
          watch,
          pendingTerminalDetection,
        );
        if (replayed) continue;
      }

      stopWatches.push(
        attachFinishNotificationWatch(dependencies, { childAgentId: record.id, watch }),
      );
    }
  }
  return () => {
    stopDelivery();
    for (const stop of stopWatches) stop();
  };
}
