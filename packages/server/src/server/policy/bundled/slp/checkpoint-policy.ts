import type {
  AgentCheckpointResult,
  AgentCheckpointSources,
  CheckpointAllowedNextStep,
  CheckpointBeadsIssueSnapshot,
  CheckpointCouncilSeatSnapshot,
  CheckpointDisposition,
  CheckpointEvidenceRef,
  CheckpointPolicy,
  CheckpointRoleActor,
  CheckpointWaitingOn,
} from "../../../agent/agent-checkpoint.js";
import { resolveAssignmentGrantState } from "../../../agent/agent-checkpoint.js";

/**
 * SLP role semantics for the generic checkpoint host in `agent-checkpoint.ts`.
 * Owns *interpretation* only: who a Lead/Peer/Supervisor is waiting on, what
 * evidence pointers matter, and what next step their role actually allows.
 *
 * Every action beyond reading evidence is gated on three adapter-supplied
 * facts, never on role name alone: the caller's live assignment grant state
 * (current/expired/missing), its authoritative relationship to the target,
 * and its exact tool-ceiling action allowlist. A policy that invented an
 * allowed action instead of reading it from `callerContext.allowedActions`
 * would itself become an unauthorized grant source; this module refuses to
 * do that.
 */
export const SLP_CHECKPOINT_POLICY_VERSION = "3";

interface SourceContribution {
  waitingOn: CheckpointWaitingOn[];
  evidence: CheckpointEvidenceRef[];
  unknowns: string[];
  /** Whether this source told us anything concrete about work disposition. */
  informative: boolean;
}

function assignmentEvidence(actor: CheckpointRoleActor, now: Date): CheckpointEvidenceRef | null {
  if (!actor.assignment) return null;
  const grantState = resolveAssignmentGrantState(actor.assignment, now);
  return {
    kind: "assignment",
    pointer: actor.assignment.assignmentDigest,
    summary: `Assignment digest ${actor.assignment.assignmentDigest} grant=${grantState} disposition=${actor.assignment.disposition}`,
  };
}

function permissionContribution(sources: AgentCheckpointSources): SourceContribution {
  if (!sources.pendingPermission) {
    return { waitingOn: [], evidence: [], unknowns: [], informative: false };
  }
  const { key, requestedAt } = sources.pendingPermission;
  return {
    waitingOn: [
      {
        actor: { kind: "human" },
        reason: `Pending permission '${key}' is unresolved and requires an approve/deny decision`,
      },
    ],
    evidence: [
      {
        kind: "pending-permission",
        pointer: key,
        summary: requestedAt
          ? `Pending permission '${key}' requested at ${requestedAt}`
          : `Pending permission '${key}' has no recorded request timestamp`,
      },
    ],
    unknowns: [],
    informative: true,
  };
}

/**
 * A Beads record's mere existence is not a disposition. A bare 'open' issue
 * with no assignee and no dependency tells us nobody has confirmed doing
 * anything about it yet; only a blocked/dependency state, a confirmed
 * in-progress assignee, or a terminal status (closed/deferred) is concrete.
 */
function beadsIsDispositionBearing(issue: CheckpointBeadsIssueSnapshot): boolean {
  if (issue.boundTargetAgentId === null) return false;
  if (
    issue.status === "blocked" ||
    (issue.dependencyDataComplete && (issue.openDependencyCount ?? 0) > 0)
  ) {
    return true;
  }
  if (issue.status === "closed" || issue.status === "deferred") return true;
  if (issue.status === "in_progress") return true;
  return false;
}

function beadsContribution(sources: AgentCheckpointSources): SourceContribution {
  const beads = sources.beads;
  if (!beads.accessible) {
    return {
      waitingOn: [],
      evidence: [],
      unknowns: [`beads_inaccessible: ${beads.reason}`],
      informative: false,
    };
  }
  if (!beads.issue) {
    return { waitingOn: [], evidence: [], unknowns: [], informative: false };
  }
  const { issue } = beads;
  const evidence: CheckpointEvidenceRef[] = [
    {
      kind: "beads",
      pointer: issue.issueId,
      summary: `Beads issue ${issue.issueId} status=${issue.status} assignee=${issue.assigneeAgentId ?? "none"} boundTarget=${issue.boundTargetAgentId ?? "none"} openDependencies=${issue.dependencyDataComplete ? issue.openDependencyCount : "unknown"}`,
    },
  ];
  const waitingOn: CheckpointWaitingOn[] = [];
  const exactTargetBinding = issue.boundTargetAgentId === sources.target.agentId;
  if (!exactTargetBinding) {
    return {
      waitingOn,
      evidence,
      unknowns: [
        `beads_target_binding_unknown: issue ${issue.issueId} has no exact binding to target ${sources.target.agentId}`,
      ],
      informative: false,
    };
  }
  if (!issue.dependencyDataComplete && issue.status !== "closed" && issue.status !== "deferred") {
    return {
      waitingOn,
      evidence,
      unknowns: [
        `beads_dependencies_incomplete: issue ${issue.issueId} did not provide a complete dependency snapshot`,
      ],
      informative: false,
    };
  }
  if (
    issue.status === "blocked" ||
    (issue.dependencyDataComplete && (issue.openDependencyCount ?? 0) > 0)
  ) {
    waitingOn.push({
      actor: { kind: "unknown" },
      reason: `Beads issue ${issue.issueId} has ${issue.dependencyDataComplete ? issue.openDependencyCount : "an unknown number of"} open dependency/dependencies (status=${issue.status})`,
    });
  }
  return { waitingOn, evidence, unknowns: [], informative: beadsIsDispositionBearing(issue) };
}

/**
 * Coordination signals are advisory evidence, never an authority transfer.
 * A resolved-only signal is listed for audit but is not, by itself, a
 * disposition source: only a still-pending signal tells us the target has
 * something outstanding to record a disposition for.
 */
function coordinationSignalContribution(sources: AgentCheckpointSources): SourceContribution {
  const waitingOn: CheckpointWaitingOn[] = [];
  const evidence: CheckpointEvidenceRef[] = [];
  let hasPending = false;
  for (const signal of sources.coordinationSignals) {
    if (signal.status === "pending") {
      hasPending = true;
      evidence.push({
        kind: "coordination-signal",
        pointer: signal.id,
        summary: `Coordination signal ${signal.id} kind=${signal.kind} reason=${signal.reason}`,
      });
      waitingOn.push({
        actor: { kind: "self" },
        reason: `Pending coordination signal ${signal.id} (${signal.kind}) awaits the target's own disposition`,
      });
    } else {
      evidence.push({
        kind: "coordination-signal",
        pointer: signal.id,
        summary: `Coordination signal ${signal.id} kind=${signal.kind} status=${signal.status} (resolved; advisory only, not a disposition source)`,
      });
    }
  }
  return { waitingOn, evidence, unknowns: [], informative: hasPending };
}

function findSeatByAgentId(
  seats: readonly CheckpointCouncilSeatSnapshot[],
  agentId: string,
): CheckpointCouncilSeatSnapshot | null {
  return seats.find((seat) => seat.agentId === agentId) ?? null;
}

function seatHasCanonicalReport(seat: CheckpointCouncilSeatSnapshot): boolean {
  return seat.integrity === "valid" && seat.hasReportReceipt;
}

function seatHasRecordedDisposition(seat: CheckpointCouncilSeatSnapshot): boolean {
  return typeof seat.disposition === "string" && seat.disposition.trim().length > 0;
}

function seatHasTerminalCanonicalDisposition(seat: CheckpointCouncilSeatSnapshot): boolean {
  return (
    seatHasCanonicalReport(seat) && seat.phase === "verdict" && seatHasRecordedDisposition(seat)
  );
}

function relevantCouncilSeats(
  council: NonNullable<AgentCheckpointSources["council"]>,
  targetIsCaseOwner: boolean,
  targetSeat: CheckpointCouncilSeatSnapshot | null,
): readonly CheckpointCouncilSeatSnapshot[] {
  if (targetIsCaseOwner) return council.seats;
  if (targetSeat) return [targetSeat];
  return [];
}

function addCouncilIntegrityUnknowns(
  seats: readonly CheckpointCouncilSeatSnapshot[],
  unknowns: string[],
): void {
  for (const seat of seats) {
    if (seat.integrity !== "compromised" && seat.integrity !== "missing") continue;
    unknowns.push(
      `council_seat_${seat.role}_integrity_${seat.integrity}: canonical disposition for this seat is missing`,
    );
  }
}

function addCaseOwnerCouncilContribution(
  council: NonNullable<AgentCheckpointSources["council"]>,
  waitingOn: CheckpointWaitingOn[],
  unknowns: string[],
): void {
  // A Lead waits on each seat that has not yet produced its own canonical
  // terminal disposition; do not assume the whole case is collected from
  // `council.phase`. A compromised/missing seat is unknown, not an
  // actionable wait on that seat, and a reported-but-nonterminal seat needs
  // a canonical verdict transition rather than a fabricated target wait.
  const laggingSeats = council.seats.filter(
    (seat) =>
      !seatHasTerminalCanonicalDisposition(seat) &&
      seat.integrity !== "compromised" &&
      seat.integrity !== "missing" &&
      !seatHasCanonicalReport(seat),
  );
  for (const seat of laggingSeats) {
    waitingOn.push({
      actor: seat.agentId
        ? { kind: "agent", agentId: seat.agentId, roleId: null }
        : { kind: "unknown" },
      reason: `Council seat '${seat.role}' has not produced a canonical report (integrity='${seat.integrity}', hasReportReceipt=${seat.hasReportReceipt})`,
    });
  }
  for (const seat of council.seats) {
    if (seatHasCanonicalReport(seat) && !seatHasTerminalCanonicalDisposition(seat)) {
      unknowns.push(
        `council_seat_${seat.role}_nonterminal: canonical verdict/disposition is not complete`,
      );
    }
  }
}

function addReportedSeatCouncilContribution(
  council: NonNullable<AgentCheckpointSources["council"]>,
  targetSeat: CheckpointCouncilSeatSnapshot,
  evidence: CheckpointEvidenceRef[],
  waitingOn: CheckpointWaitingOn[],
  unknowns: string[],
): void {
  // Only a seat that has itself reported waits on Lead review — a seat
  // still working is not "waiting" merely because the case exists.
  evidence.push({
    kind: "council",
    pointer: targetSeat.reportReceiptPointer ?? council.caseId,
    summary: `Council seat '${targetSeat.role}' reported (disposition=${targetSeat.disposition ?? "none recorded"})`,
  });
  if (seatHasTerminalCanonicalDisposition(targetSeat)) return;
  if (seatHasRecordedDisposition(targetSeat) && targetSeat.phase !== "verdict") {
    waitingOn.push({
      actor: council.parentAgentId
        ? { kind: "agent", agentId: council.parentAgentId, roleId: "lead" }
        : { kind: "unknown" },
      reason: `Council seat '${targetSeat.role}' has a canonical report and recorded disposition but awaits Lead's review/verdict binding`,
    });
    return;
  }
  unknowns.push(
    `council_seat_${targetSeat.role}_disposition_unresolved: canonical terminal disposition is unavailable`,
  );
}

function councilContribution(sources: AgentCheckpointSources): SourceContribution {
  const council = sources.council;
  if (!council) return { waitingOn: [], evidence: [], unknowns: [], informative: false };

  const evidence: CheckpointEvidenceRef[] = [
    {
      kind: "council",
      pointer: council.caseId,
      summary: `Council case ${council.caseId}; case-level phase '${council.phase}' is the furthest-advanced seat only and does not by itself prove full collection or a bound verdict`,
    },
  ];
  const waitingOn: CheckpointWaitingOn[] = [];
  const unknowns: string[] = [];
  const targetAgentId = sources.target.agentId;
  const targetIsCaseOwner = council.parentAgentId === targetAgentId;
  const targetSeat = findSeatByAgentId(council.seats, targetAgentId);

  addCouncilIntegrityUnknowns(
    relevantCouncilSeats(council, targetIsCaseOwner, targetSeat),
    unknowns,
  );
  if (targetIsCaseOwner) {
    addCaseOwnerCouncilContribution(council, waitingOn, unknowns);
  } else if (targetSeat && seatHasCanonicalReport(targetSeat)) {
    addReportedSeatCouncilContribution(council, targetSeat, evidence, waitingOn, unknowns);
  }

  // A seat that exists but has not yet reported, or a target unrelated to
  // this case, yields no council-based waitingOn claim.
  const informative =
    waitingOn.length > 0 ||
    unknowns.length > 0 ||
    (targetIsCaseOwner && council.seats.some(seatHasTerminalCanonicalDisposition)) ||
    Boolean(targetSeat && seatHasTerminalCanonicalDisposition(targetSeat));
  return { waitingOn, evidence, unknowns, informative };
}

function summarizeDisposition(
  waitingOn: readonly CheckpointWaitingOn[],
  unknowns: readonly string[],
  hasAnySource: boolean,
): CheckpointDisposition {
  if (!hasAnySource) return "unknown";
  if (waitingOn.length === 0 && unknowns.length > 0) return "unknown";
  if (waitingOn.length === 0) return "no-outstanding-dependency";
  const targetWaitsOnOther = waitingOn.some((entry) => entry.actor.kind !== "self");
  return targetWaitsOnOther ? "waiting-on-other" : "other-waiting-on-actor";
}

const READ_EVIDENCE_RATIONALE =
  "Only reading the assembled evidence is authorized from the current facts.";
const OBSERVE_ONLY_RATIONALE =
  "Supervisor inspects without accept/restart/replace authority in ordinary orchestration.";

function baseReadStep(sources: AgentCheckpointSources): CheckpointAllowedNextStep {
  if (sources.caller.roleId === "supervisor") {
    return { action: "observe_only", rationale: OBSERVE_ONLY_RATIONALE };
  }
  return { action: "read_evidence", rationale: READ_EVIDENCE_RATIONALE };
}

/**
 * Every step beyond reading is gated on the caller's live grant, its
 * authoritative relationship to the target, and its exact tool-ceiling
 * allowlist — never on role name alone. An expired/missing grant or an
 * "unrelated" relationship yields read-only guidance regardless of role.
 */
function buildAllowedNextSteps(
  sources: AgentCheckpointSources,
  waitingOn: readonly CheckpointWaitingOn[],
  disposition: CheckpointDisposition,
): CheckpointAllowedNextStep[] {
  const grantState = resolveAssignmentGrantState(sources.caller.assignment, sources.now);
  if (grantState !== "current") {
    const base = baseReadStep(sources);
    return [
      {
        action: base.action,
        rationale: `Caller assignment grant is '${grantState}'; only reading evidence is authorized until a current assignment is presented.`,
      },
    ];
  }

  const relationship = sources.callerContext.relationshipToTarget;
  if (relationship === "unrelated") {
    const base = baseReadStep(sources);
    return [
      {
        action: base.action,
        rationale:
          "Caller has no authorized ownership/observation relationship to this target; only reading evidence is authorized.",
      },
    ];
  }

  if (disposition === "unknown") {
    return [
      {
        action: "gather_missing_evidence",
        rationale:
          "Disposition is unknown from the sources read; collect the named missing evidence before acting.",
      },
    ];
  }

  const allowedActions = new Set(sources.callerContext.allowedActions ?? []);
  const hasExternalWait = waitingOn.some((entry) => entry.actor.kind !== "self");
  const steps: CheckpointAllowedNextStep[] = [baseReadStep(sources)];
  const roleId = sources.caller.roleId;

  if (roleId === "lead") {
    if (hasExternalWait && allowedActions.has("request_status_update")) {
      steps.push({
        action: "request_status_update",
        rationale:
          "Lead's live tool ceiling authorizes requesting a status update; this grants no unilateral accept authority.",
      });
    }
  } else if (roleId === "peer") {
    if (allowedActions.has("continue_bounded_work")) {
      steps.push({
        action: "continue_bounded_work",
        rationale: "Peer's live tool ceiling authorizes continuing within its own bounded lease.",
      });
    }
    if (hasExternalWait && allowedActions.has("handback_with_evidence")) {
      steps.push({
        action: "handback_with_evidence",
        rationale:
          "Peer's live tool ceiling authorizes surfacing evidence and handing back; a Peer cannot resolve another role's authority gap.",
      });
    }
  } else if (roleId === "supervisor") {
    if (hasExternalWait && allowedActions.has("flag_to_human")) {
      steps.push({
        action: "flag_to_human",
        rationale:
          "Supervisor's live tool ceiling authorizes relaying through a bounded Human recovery lease; it does not bypass Lead.",
      });
    }
  }

  return steps;
}

function project(sources: AgentCheckpointSources): AgentCheckpointResult {
  const unknowns: string[] = [];
  const waitingOn: CheckpointWaitingOn[] = [];
  const evidence: CheckpointEvidenceRef[] = [];

  if (sources.targetLifecycle === null) {
    unknowns.push("lifecycle_unknown: target lifecycle snapshot could not be read");
  }

  const callerAssignmentEvidence = assignmentEvidence(sources.caller, sources.now);
  if (callerAssignmentEvidence) evidence.push(callerAssignmentEvidence);
  const targetAssignmentEvidence = assignmentEvidence(sources.target, sources.now);
  if (targetAssignmentEvidence) evidence.push(targetAssignmentEvidence);

  const permission = permissionContribution(sources);
  const beads = beadsContribution(sources);
  const signals = coordinationSignalContribution(sources);
  const council = councilContribution(sources);

  for (const contribution of [permission, beads, signals, council]) {
    waitingOn.push(...contribution.waitingOn);
    evidence.push(...contribution.evidence);
    unknowns.push(...contribution.unknowns);
  }

  // Lifecycle alone (e.g. "idle"), a merely-existing Beads record, or a
  // resolved-only coordination signal is never treated as a disposition
  // source: only a source that yielded a concrete wait or a concrete unknown
  // counts. Idle with nothing else is UNKNOWN, not "done".
  const hasAnySource =
    permission.informative || beads.informative || signals.informative || council.informative;

  if (!hasAnySource) {
    unknowns.push(
      "no_disposition_source: target reports idle/no-data with no permission, Beads, Council, or signal evidence — do not infer completion from idle alone",
    );
  }

  const disposition = summarizeDisposition(waitingOn, unknowns, hasAnySource);
  const allowedNextSteps = buildAllowedNextSteps(sources, waitingOn, disposition);

  return {
    agentId: sources.target.agentId,
    disposition,
    waitingOn,
    evidence,
    allowedNextSteps,
    unknowns,
  };
}

export const SLP_CHECKPOINT_POLICY: CheckpointPolicy = {
  id: "slp",
  version: SLP_CHECKPOINT_POLICY_VERSION,
  project,
};
