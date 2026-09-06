import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { AssignmentContractReceipt } from "@getpaseo/protocol/assignment-contract";
import type {
  CouncilPhase,
  CouncilSeatIntegrity,
  CouncilSeatRole,
} from "@getpaseo/protocol/council/types";
import type { CoordinationSignal } from "@getpaseo/protocol/coordination-signal";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

/**
 * Generic host mechanics for a bounded, read-only "checkpoint" projection: given
 * already-fetched authoritative snapshots (caller/target assignment, pending
 * permission, coordination signals, canonical Council case, Beads issue), answer
 * "who is waiting on whom, what evidence exists, what next steps are actually
 * allowed" without mutating anything or inventing disposition/acceptance the
 * source data does not carry.
 *
 * This module owns assembly only. It never reaches into storage, Beads, Council,
 * or role-enforcement itself, and it never decides *whether* the caller may read
 * the target — that authorization is computed upstream (by the same enforcement
 * that already guards get_agent_status / list_agents / role-scoped Beads tools)
 * and handed in as `readAuthorization`. Role-specific interpretation of the
 * assembled sources is delegated to an injected `CheckpointPolicy` so SLP
 * semantics stay separable from these host mechanics.
 */

export type AssignmentGrantState = "current" | "expired" | "missing";

export interface CheckpointReadAuthorization {
  authorized: boolean;
  /** Always present: why access was granted or denied, for evidence/audit. */
  reason: string;
}

export interface CheckpointRoleActor {
  agentId: string;
  /** Null when the actor has no bound Paseo role (unbound provider session). */
  roleId: PaseoRoleId | null;
  /** Null when there is no assignment receipt to read (no grant). */
  assignment: AssignmentContractReceipt | null;
}

export interface CheckpointPendingPermission {
  key: string;
  requestedAt: string | null;
}

/**
 * Authoritative relationship of the caller to the target, as resolved by the
 * same ownership/lease enforcement that already gates the underlying tools
 * (parent/child Lead-Peer links, Supervisor's exact bounded delegation scope).
 * This module never derives ownership from role name or workspace equality;
 * it only consumes what the adapter attests.
 */
export type CheckpointCallerRelationship =
  | "self"
  | "owns-target"
  | "supervises-target"
  | "unrelated";

/**
 * Exact action ids the caller's live assignment effect class and tool ceiling
 * authorize beyond reading, as resolved by the adapter from the real grant —
 * never inferred here from role name alone. `null` means the adapter did not
 * resolve a ceiling for this call; the projection must fail closed to
 * read-only guidance rather than assume any action is permitted.
 */
export interface CheckpointCallerContext {
  relationshipToTarget: CheckpointCallerRelationship;
  allowedActions: readonly string[] | null;
}

export interface CheckpointCouncilSeatSnapshot {
  role: CouncilSeatRole;
  agentId: string | null;
  phase: CouncilPhase;
  integrity: CouncilSeatIntegrity;
  hasReportReceipt: boolean;
  /** Stable pointer into the canonical report receipt (e.g. its message id); null when no receipt exists. */
  reportReceiptPointer: string | null;
  /** The seat's own recorded disposition text, if any was reported. */
  disposition: string | null;
}

export interface CheckpointCouncilSnapshot {
  caseId: string;
  /**
   * The canonical store defines this as the *maximum* phase across seats, not
   * a whole-case collection barrier. A single advanced seat can put this at
   * "verdict" while other seats have not reported. Never treat this field
   * alone as proof the case is fully collected — derive that per seat.
   */
  phase: CouncilPhase;
  parentAgentId: string | null;
  seats: readonly CheckpointCouncilSeatSnapshot[];
}

export type CheckpointBeadsIssueStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed";

export interface CheckpointBeadsIssueSnapshot {
  issueId: string;
  status: CheckpointBeadsIssueStatus;
  assigneeAgentId: string | null;
  /** Null when the adapter did not receive a complete dependency snapshot. */
  openDependencyCount: number | null;
  /** Exact target binding, never inferred from `assigneeAgentId`. */
  boundTargetAgentId: string | null;
  /** True only when the adapter read the full dependency set for this issue. */
  dependencyDataComplete: boolean;
}

/** Beads Central may be unavailable to the caller; never fabricate a snapshot. */
export type CheckpointBeadsSnapshot =
  | { accessible: false; reason: string }
  | { accessible: true; issue: CheckpointBeadsIssueSnapshot | null };

export interface AgentCheckpointSources {
  now: Date;
  caller: CheckpointRoleActor;
  target: CheckpointRoleActor;
  readAuthorization: CheckpointReadAuthorization;
  /** Honest facts the adapter must resolve from live grant/ownership state; never invented by a policy. */
  callerContext: CheckpointCallerContext;
  /** Null when the target's lifecycle snapshot itself could not be read. */
  targetLifecycle: AgentLifecycleStatus | null;
  pendingPermission: CheckpointPendingPermission | null;
  coordinationSignals: readonly CoordinationSignal[];
  council: CheckpointCouncilSnapshot | null;
  beads: CheckpointBeadsSnapshot;
}

export type CheckpointWaitingActor =
  | { kind: "self" }
  | { kind: "agent"; agentId: string; roleId: PaseoRoleId | null }
  | { kind: "human" }
  | { kind: "unknown" };

export interface CheckpointWaitingOn {
  actor: CheckpointWaitingActor;
  reason: string;
}

export type CheckpointEvidenceKind =
  | "assignment"
  | "council"
  | "beads"
  | "coordination-signal"
  | "pending-permission";

export interface CheckpointEvidenceRef {
  kind: CheckpointEvidenceKind;
  pointer: string;
  summary: string;
}

export interface CheckpointAllowedNextStep {
  action: string;
  rationale: string;
}

export type CheckpointDisposition =
  | "unauthorized"
  | "unknown"
  | "no-outstanding-dependency"
  | "waiting-on-other"
  | "other-waiting-on-actor";

export interface AgentCheckpointResult {
  agentId: string;
  disposition: CheckpointDisposition;
  waitingOn: readonly CheckpointWaitingOn[];
  evidence: readonly CheckpointEvidenceRef[];
  allowedNextSteps: readonly CheckpointAllowedNextStep[];
  /** Named gaps in the source data. Never treated as "idle therefore done". */
  unknowns: readonly string[];
}

/** Pure role-semantics contribution; the bundled `slp` policy owns one. */
export interface CheckpointPolicy {
  id: string;
  version: string;
  project(sources: AgentCheckpointSources): AgentCheckpointResult;
}

/**
 * Pure date math over an already-fetched receipt. Distinguishes "no grant was
 * ever presented" from "a grant exists but its window has closed" — the two
 * read very differently in an evidence report and must not be conflated.
 */
export function resolveAssignmentGrantState(
  assignment: AssignmentContractReceipt | null,
  now: Date,
): AssignmentGrantState {
  if (!assignment) return "missing";
  if (assignment.expiresAt && Date.parse(assignment.expiresAt) <= now.getTime()) {
    return "expired";
  }
  return "current";
}

const UNAUTHORIZED_RESULT_UNKNOWNS_PREFIX = "read_not_authorized";

/**
 * Orchestrate the projection. Read authorization is checked first and short-
 * circuits with an empty, evidence-free result: an unauthorized caller must
 * never receive evidence pointers, waitingOn detail, or allowed-step guidance
 * derived from a target it cannot read.
 */
export function buildAgentCheckpoint(
  sources: AgentCheckpointSources,
  policy: CheckpointPolicy,
): AgentCheckpointResult {
  if (!sources.readAuthorization.authorized) {
    return {
      agentId: sources.target.agentId,
      disposition: "unauthorized",
      waitingOn: [],
      evidence: [],
      allowedNextSteps: [],
      unknowns: [`${UNAUTHORIZED_RESULT_UNKNOWNS_PREFIX}: ${sources.readAuthorization.reason}`],
    };
  }
  return policy.project(sources);
}
