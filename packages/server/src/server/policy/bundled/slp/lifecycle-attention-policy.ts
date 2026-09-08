import type { AgentManagerEvent, ManagedAgent } from "../../../agent/agent-manager.js";
import { policyOwnerForRoleBinding } from "../../../agent/role-binding.js";
import {
  requestCoordinationSignal,
  updateEventPolicyState,
  type EventPolicyStateOwner,
  type EventPolicyStateSpec,
} from "../../../agent/coordination-signals.js";
import type {
  AgentEventPolicy,
  AgentEventPolicyProcessor,
  EventPolicyRuntimeDependencies,
} from "../../../agent/event-policy-runtime.js";
import { resolveAttentionEscalationRoute, type AttentionRouteAgent } from "./attention-policy.js";

export const SLP_LIFECYCLE_ATTENTION_POLICY_ID = "slp.lifecycle-attention";
export const SLP_LIFECYCLE_ATTENTION_POLICY_VERSION = "2";
export const SLP_LIFECYCLE_ATTENTION_STATE_VERSION = 1;
export const SLP_LIFECYCLE_ATTENTION_DISABLE_FLAG = "PASEO_DISABLE_SLP_LIFECYCLE_ATTENTION_POLICY";

/**
 * A single pending permission is a legitimate wait (the run is correctly blocked on a real
 * decision) and must not be treated as attention-worthy on its own. Only a permission that has
 * stayed unresolved past this bound, still observed pending at a later event, is escalated.
 */
const PENDING_PERMISSION_ATTENTION_WAIT_MS = 120_000;
const MAX_TRACKED_PENDING_PERMISSIONS = 20;

interface PendingPermissionWait {
  requestedAt: number;
  signaledAt: number | null;
}

interface SlpLifecycleAttentionState extends Record<string, unknown> {
  pendingPermissionWaits: Record<string, PendingPermissionWait>;
}

const INITIAL_SLP_LIFECYCLE_ATTENTION_STATE: SlpLifecycleAttentionState = {
  pendingPermissionWaits: {},
};

function parsePendingPermissionWait(value: unknown): PendingPermissionWait | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const requestedAt = record.requestedAt;
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return null;
  const signaledAt = record.signaledAt;
  return {
    requestedAt,
    signaledAt: typeof signaledAt === "number" && Number.isFinite(signaledAt) ? signaledAt : null,
  };
}

function parsePendingPermissionWaits(value: unknown): Record<string, PendingPermissionWait> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, PendingPermissionWait> = {};
  for (const [requestId, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parsePendingPermissionWait(entry);
    if (parsed) result[requestId] = parsed;
  }
  return result;
}

function parseSlpLifecycleAttentionState(input: unknown): SlpLifecycleAttentionState {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    pendingPermissionWaits: parsePendingPermissionWaits(value.pendingPermissionWaits),
  };
}

const SLP_LIFECYCLE_ATTENTION_STATE: EventPolicyStateSpec<SlpLifecycleAttentionState> = {
  policyId: SLP_LIFECYCLE_ATTENTION_POLICY_ID,
  version: SLP_LIFECYCLE_ATTENTION_STATE_VERSION,
  initialState: INITIAL_SLP_LIFECYCLE_ATTENTION_STATE,
  parseState: parseSlpLifecycleAttentionState,
};

function capPendingPermissionWaits(
  waits: Record<string, PendingPermissionWait>,
): Record<string, PendingPermissionWait> {
  const entries = Object.entries(waits);
  if (entries.length <= MAX_TRACKED_PENDING_PERMISSIONS) return waits;
  entries.sort((left, right) => left[1].requestedAt - right[1].requestedAt);
  return Object.fromEntries(entries.slice(entries.length - MAX_TRACKED_PENDING_PERMISSIONS));
}

async function handlePermissionRequested(
  dependencies: EventPolicyRuntimeDependencies,
  agent: ManagedAgent,
  requestId: string,
  owner: EventPolicyStateOwner,
): Promise<void> {
  await updateEventPolicyState(
    dependencies,
    agent.id,
    owner,
    SLP_LIFECYCLE_ATTENTION_STATE,
    (state) => {
      if (state.pendingPermissionWaits[requestId]) {
        return { state, result: undefined };
      }
      const pendingPermissionWaits = capPendingPermissionWaits({
        ...state.pendingPermissionWaits,
        [requestId]: { requestedAt: Date.now(), signaledAt: null },
      });
      return { state: { ...state, pendingPermissionWaits }, result: undefined };
    },
  );
}

async function handlePermissionResolved(
  dependencies: EventPolicyRuntimeDependencies,
  agent: ManagedAgent,
  requestId: string,
  owner: EventPolicyStateOwner,
): Promise<void> {
  await updateEventPolicyState(
    dependencies,
    agent.id,
    owner,
    SLP_LIFECYCLE_ATTENTION_STATE,
    (state) => {
      if (!(requestId in state.pendingPermissionWaits)) return { state, result: undefined };
      const pendingPermissionWaits = { ...state.pendingPermissionWaits };
      delete pendingPermissionWaits[requestId];
      return { state: { ...state, pendingPermissionWaits }, result: undefined };
    },
  );
}

interface StalePendingPermission {
  requestId: string;
  waitedMs: number;
}

/**
 * Read-only: never mutates `signaledAt`. Marking "signaled" happens only in
 * `markPendingPermissionSignaled`, and only after `requestCoordinationSignal` has actually
 * succeeded — see `checkStalePendingPermissions` for why the two are split.
 */
async function findStalePendingPermissions(
  dependencies: EventPolicyRuntimeDependencies,
  agentId: string,
  owner: EventPolicyStateOwner,
  now: number,
): Promise<StalePendingPermission[]> {
  return updateEventPolicyState(
    dependencies,
    agentId,
    owner,
    SLP_LIFECYCLE_ATTENTION_STATE,
    (state) => {
      const staleEntries: StalePendingPermission[] = [];
      for (const [requestId, wait] of Object.entries(state.pendingPermissionWaits)) {
        if (wait.signaledAt !== null) continue;
        const waitedMs = now - wait.requestedAt;
        if (waitedMs < PENDING_PERMISSION_ATTENTION_WAIT_MS) continue;
        staleEntries.push({ requestId, waitedMs });
      }
      return { state, result: staleEntries };
    },
  );
}

async function markPendingPermissionSignaled(
  dependencies: EventPolicyRuntimeDependencies,
  agentId: string,
  owner: EventPolicyStateOwner,
  requestId: string,
  signaledAt: number,
): Promise<void> {
  await updateEventPolicyState(
    dependencies,
    agentId,
    owner,
    SLP_LIFECYCLE_ATTENTION_STATE,
    (state) => {
      const wait = state.pendingPermissionWaits[requestId];
      if (!wait || wait.signaledAt !== null) return { state, result: undefined };
      const pendingPermissionWaits = {
        ...state.pendingPermissionWaits,
        [requestId]: { ...wait, signaledAt },
      };
      return { state: { ...state, pendingPermissionWaits }, result: undefined };
    },
  );
}

/**
 * Re-checked on every subsequent stream event for the agent (never on a timer): a permission
 * that is still pending once another event has arrived, past the wait bound, is evidence of a
 * genuinely blocked run rather than an ordinary fast approval — the elapsed time alone is not
 * treated as proof of a stall, only as the bound past which a still-pending request is worth
 * escalating; the wording below stays hedged ("may be legitimately blocked") rather than
 * asserting a stall verdict, since a Human can legitimately take this long to respond.
 *
 * Staleness is read from durable state, but `signaledAt` is only durably marked *after*
 * `requestCoordinationSignal` has actually enqueued: marking it first (inside the same read)
 * would strand the incident forever if the enqueue call then failed. Each stale requestId is
 * also re-checked against the live `agent.pendingPermissions` map (not just its non-zero size)
 * immediately before signaling, so a request already resolved in the gap between the durable
 * read and the signal never raises attention for something no longer pending.
 */
async function checkStalePendingPermissions(
  dependencies: EventPolicyRuntimeDependencies,
  agent: ManagedAgent,
  owner: EventPolicyStateOwner,
): Promise<void> {
  const route = resolveAttentionEscalationRoute(dependencies, agent);
  if (!route || !route.target) return;
  const now = Date.now();
  const stale = await findStalePendingPermissions(dependencies, agent.id, owner, now);
  for (const { requestId, waitedMs } of stale) {
    const request = agent.pendingPermissions.get(requestId);
    if (!request) continue;
    try {
      await requestCoordinationSignal(dependencies, {
        targetAgentId: route.target.id,
        requestedByAgentId: null,
        kind: "continuity_attention",
        customEvent: "slp.pending_permission_wait",
        severity: route.severity,
        recipientRole: route.recipientRole,
        source: {
          kind: "paseo",
          ruleId: "pending_permission_wait",
          version: SLP_LIFECYCLE_ATTENTION_STATE_VERSION,
        },
        coalescingKey: `pending_permission_wait:${agent.id}:${requestId}`,
        reason:
          "A permission request stayed pending past the bundled SLP wait threshold; the run may be legitimately blocked on a decision.",
        relatedAgentId: agent.id,
        evidence: {
          provider: agent.provider,
          requestId,
          waitedMs,
          threshold: PENDING_PERMISSION_ATTENTION_WAIT_MS,
          ...(request.kind ? { permissionKind: request.kind } : {}),
          ...(request.name ? { permissionName: request.name } : {}),
        },
      });
      await markPendingPermissionSignaled(dependencies, agent.id, owner, requestId, now);
    } catch (error) {
      dependencies.logger.warn(
        { err: error, agentId: agent.id, requestId },
        "Failed to raise pending-permission attention; will retry on a later event",
      );
    }
  }
}

function samePolicyOwner(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Closure evidence is emitted before the live agent is removed and before its tracked run is
 * cleared. The closed snapshot deliberately has null active-turn fields, so role/label and owner
 * context come from the authoritative stored record while the event's pinned owner selects the
 * policy generation. A pending prelaunch token is not a lost run: both an observed turn id and a
 * launch-start timestamp are required.
 */
async function handleRunClearedAtClosure(
  dependencies: EventPolicyRuntimeDependencies,
  event: Extract<AgentManagerEvent, { type: "agent_closure" }>,
): Promise<void> {
  if (
    event.internal ||
    event.policyOwner?.kind !== "plugin" ||
    !event.run?.turnId ||
    !event.run.startedAt
  ) {
    return;
  }

  const record = await dependencies.agentStorage.get(event.agentId);
  if (
    !record ||
    record.internal ||
    record.archivedAt ||
    !record.roleBinding ||
    !samePolicyOwner(policyOwnerForRoleBinding(record.roleBinding), event.policyOwner)
  ) {
    return;
  }

  const routeAgent: AttentionRouteAgent = {
    roleBinding: record.roleBinding,
    labels: record.labels,
    workspaceId: record.workspaceId,
    lifecycle: "closed",
  };
  const route = resolveAttentionEscalationRoute(dependencies, routeAgent);
  if (!route?.target) return;

  await requestCoordinationSignal(dependencies, {
    targetAgentId: route.target.id,
    requestedByAgentId: null,
    kind: "continuity_attention",
    customEvent: "slp.lost_run",
    severity: route.severity,
    recipientRole: route.recipientRole,
    source: {
      kind: "paseo",
      ruleId: "lost_run_on_closure",
      version: SLP_LIFECYCLE_ATTENTION_STATE_VERSION,
    },
    coalescingKey: `lost_run_on_closure:${event.agentId}:${event.run.turnId}`,
    reason:
      "Agent closure cleared a tracked started run before a terminal turn event; review the interruption evidence at a safe boundary.",
    relatedAgentId: event.agentId,
    evidence: {
      cause: event.cause,
      lifecycleBeforeClose: event.lifecycleBeforeClose,
      runKind: event.run.kind,
      turnId: event.run.turnId,
      startedAt: event.run.startedAt,
    },
  });
}

function createLifecycleAttentionProcessor(
  dependencies: EventPolicyRuntimeDependencies,
): AgentEventPolicyProcessor {
  return {
    async handleEvent(event, owner) {
      if (event.type === "agent_closure") {
        await handleRunClearedAtClosure(dependencies, event);
        return;
      }
      if (event.type !== "agent_stream") return;
      const agent = dependencies.agentManager.getAgent(event.agentId);
      if (!agent?.roleBinding || agent.internal) return;
      if (event.event.type === "permission_requested") {
        await handlePermissionRequested(dependencies, agent, event.event.request.id, owner);
      } else if (event.event.type === "permission_resolved") {
        await handlePermissionResolved(dependencies, agent, event.event.requestId, owner);
      }
      // Cheap in-memory short-circuit: skip the durable-state read/write on every ordinary
      // stream event for agents with nothing pending, which is the common case.
      if (agent.pendingPermissions.size > 0) {
        await checkStalePendingPermissions(dependencies, agent, owner);
      }
    },
  };
}

export function slpLifecycleAttentionPolicyEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[SLP_LIFECYCLE_ATTENTION_DISABLE_FLAG] !== "1";
}

export const SLP_LIFECYCLE_ATTENTION_EVENT_POLICY: AgentEventPolicy = {
  id: SLP_LIFECYCLE_ATTENTION_POLICY_ID,
  version: SLP_LIFECYCLE_ATTENTION_POLICY_VERSION,
  subscriptions: ["agent_stream", "agent_closure"],
  enabled: slpLifecycleAttentionPolicyEnabled,
  createProcessor: createLifecycleAttentionProcessor,
};
