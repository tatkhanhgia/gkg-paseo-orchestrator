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
import type {
  AgentEpisodeReport,
  AgentEpisodeReportSources,
  EpisodeDimension,
  EpisodeEvidenceEntry,
  EpisodeLineageField,
  EpisodeReportPolicy,
  EpisodeReportRequest,
} from "../../../agent/agent-episode-report.js";
import type { AgentTimelineItem } from "../../../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../../../agent/agent-timeline-store-types.js";
import type { SupervisorNotebookRecord } from "@getpaseo/protocol/notebook-record";

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

const EPISODE_UNKNOWN =
  "Episode report is evidence only; it grants no writer, Beads, acceptance, or rule-promotion authority.";

function episodeFact(pointer: string, summary: string): EpisodeEvidenceEntry {
  return { sourceClass: "source-fact", pointer, summary };
}

function episodeClaim(pointer: string, summary: string): EpisodeEvidenceEntry {
  return { sourceClass: "agent-claim", pointer, summary };
}

function uniqueEvidence(entries: readonly EpisodeEvidenceEntry[]): EpisodeEvidenceEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.sourceClass}:${entry.pointer}:${entry.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dimension(
  status: EpisodeDimension["status"],
  sourceFacts: readonly EpisodeEvidenceEntry[] = [],
  claims: readonly EpisodeEvidenceEntry[] = [],
  inference: string | null = null,
): EpisodeDimension {
  return {
    status,
    sourceFacts: uniqueEvidence(sourceFacts),
    claims: uniqueEvidence(claims),
    inference,
  };
}

function lineage(
  requested: string | null,
  observed: string | null,
  status: EpisodeDimension["status"],
  sourceFacts: readonly EpisodeEvidenceEntry[] = [],
  claims: readonly EpisodeEvidenceEntry[] = [],
  inference: string | null = null,
): EpisodeLineageField {
  return {
    requested,
    observed,
    ...dimension(status, sourceFacts, claims, inference),
  };
}

function sourceStatusUnknown(status: AgentEpisodeReportSources["activity"]["status"]): boolean {
  return (
    status === "missing" || status === "unavailable" || status === "stale" || status === "ambiguous"
  );
}

function summarizeTimelineItem(item: AgentTimelineItem): string {
  switch (item.type) {
    case "tool_call":
      return `tool '${item.name}' status=${item.status}`;
    case "user_message":
      return "user message observed";
    case "assistant_message":
      return "assistant message observed (content is a claim, not an authority receipt)";
    case "reasoning":
      return "reasoning activity observed (content omitted)";
    case "todo":
      return `todo activity observed (${item.items.length} item(s))`;
    case "error":
      return "error activity observed";
    case "compaction":
      return `compaction activity status=${item.status}`;
  }
}

function timelinePointer(row: AgentTimelineRow): string {
  return `timeline:${row.seq}`;
}

/** Extract text only to preserve a bounded activity claim, never an artifact proof. */
function timelineTextForClaimMatching(item: AgentTimelineItem): string {
  switch (item.type) {
    case "tool_call": {
      const detail = item.detail;
      if (detail.type === "shell") return detail.command;
      if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
        return detail.filePath;
      }
      if (detail.type === "search") return detail.query;
      if (detail.type === "fetch") return detail.url;
      return "";
    }
    case "user_message":
    case "assistant_message":
      return item.text;
    case "reasoning":
      // Reasoning content is not an evidence source. Keep it out of
      // candidate/ref matching as well as the rendered report.
      return "";
    case "error":
      return item.message;
    case "todo":
      return item.items.map((entry) => entry.text).join(" ");
    case "compaction":
      return "compaction";
  }
}

function isInEpisodeWindow(row: AgentTimelineRow, request: EpisodeReportRequest): boolean {
  const timestamp = Date.parse(row.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= Date.parse(request.window.from) && timestamp < Date.parse(request.window.to);
}

function episodeActivityRows(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
): readonly AgentTimelineRow[] {
  if (sources.activity.status !== "available") return [];
  return sources.activity.rows.filter((row) => isInEpisodeWindow(row, request));
}

function isTestCommand(command: string): boolean {
  return /(?:vitest|npm\s+(?:run\s+)?(?:test|typecheck|lint|format)|node\s+--test|pytest|cargo\s+test|go\s+test)/iu.test(
    command,
  );
}

function activitySourceFacts(rows: readonly AgentTimelineRow[]): EpisodeEvidenceEntry[] {
  return rows.map((row) => episodeFact(timelinePointer(row), summarizeTimelineItem(row.item)));
}

function activityClaims(rows: readonly AgentTimelineRow[]): EpisodeEvidenceEntry[] {
  return rows.flatMap((row) => {
    if (row.item.type !== "user_message" && row.item.type !== "assistant_message") return [];
    if (!/(?:test|pass(?:ed)?|hand.?back|handoff|accept|ready)/iu.test(row.item.text)) return [];
    return [
      episodeClaim(
        timelinePointer(row),
        "Agent-authored activity mentions test, delivery, handback, readiness, or acceptance; the text is not a canonical receipt.",
      ),
    ];
  });
}

function testPassDimension(
  sources: AgentEpisodeReportSources,
  rows: readonly AgentTimelineRow[],
): EpisodeDimension {
  if (sourceStatusUnknown(sources.activity.status) || sources.activity.truncated) {
    return dimension(
      "unknown",
      [],
      [],
      sources.activity.truncated
        ? "Activity source is bounded and older rows may be omitted; test-pass state remains unknown."
        : `Activity source is ${sources.activity.status}; test-pass state remains unknown.`,
    );
  }
  const testRows = rows.filter(
    (row) =>
      row.item.type === "tool_call" &&
      row.item.detail.type === "shell" &&
      isTestCommand(row.item.detail.command),
  );
  const successful = testRows.filter(
    (row) =>
      row.item.type === "tool_call" &&
      row.item.status === "completed" &&
      row.item.detail.type === "shell" &&
      row.item.detail.exitCode === 0,
  );
  const failed = testRows.filter(
    (row) =>
      row.item.type === "tool_call" &&
      row.item.detail.type === "shell" &&
      (row.item.status === "failed" ||
        (typeof row.item.detail.exitCode === "number" && row.item.detail.exitCode !== 0)),
  );
  const claims = activityClaims(rows);
  if (successful.length > 0 || failed.length > 0) {
    const sourceFacts = [
      ...successful.map((row) =>
        episodeFact(timelinePointer(row), "Bounded test/check command completed with exitCode=0."),
      ),
      ...failed.map((row) =>
        episodeFact(timelinePointer(row), "Bounded test/check command failed."),
      ),
    ];
    let inference: string;
    if (successful.length > 0 && failed.length > 0) {
      inference =
        "Both successful and failed bounded checks are preserved; a later green check does not erase counterevidence.";
    } else if (successful.length > 0) {
      inference =
        "A successful bounded command is evidence of an exercised check, not Lead acceptance or outcome support.";
    } else {
      inference =
        "A failed check is preserved as evidence; it is not converted into an acceptance verdict.";
    }
    return dimension(
      successful.length > 0 ? "exercised" : "present",
      sourceFacts,
      claims,
      inference,
    );
  }
  if (claims.length > 0) {
    return dimension(
      "present",
      [],
      claims,
      "The activity contains a test-pass claim but no canonical successful check receipt was observed.",
    );
  }
  return dimension(
    "unobserved",
    [],
    [],
    "No bounded test/check execution was observed in the requested window.",
  );
}

function deliveryDimension(
  sources: AgentEpisodeReportSources,
  rows: readonly AgentTimelineRow[],
): EpisodeDimension {
  if (sourceStatusUnknown(sources.activity.status) || sources.activity.truncated) {
    return dimension(
      "unknown",
      [],
      [],
      sources.activity.truncated
        ? "Activity source is bounded and older delivery rows may be omitted."
        : `Activity source is ${sources.activity.status}; delivery state remains unknown.`,
    );
  }
  const delivered = rows.filter(
    (row) =>
      row.item.type === "tool_call" &&
      row.item.status === "completed" &&
      ["post_room", "send_agent_prompt", "append_project_notebook_record"].includes(row.item.name),
  );
  const claims = activityClaims(rows);
  if (delivered.length > 0) {
    return dimension(
      "exercised",
      delivered.map((row) =>
        episodeFact(timelinePointer(row), "Bounded delivery tool call completed."),
      ),
      claims,
      "Delivery dispatch is distinct from recipient readback and Lead acceptance.",
    );
  }
  if (claims.length > 0) {
    return dimension(
      "present",
      [],
      claims,
      "Delivery is only claimed in activity; no canonical delivery receipt was observed.",
    );
  }
  return dimension(
    "unobserved",
    [],
    [],
    "No bounded delivery action was observed in the requested window.",
  );
}

function handbackDimension(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
  rows: readonly AgentTimelineRow[],
): EpisodeDimension {
  const packetFacts =
    sources.handoff.status === "available"
      ? sources.handoff.packets
          .filter(
            (packet) =>
              packet.objective === request.objective ||
              packet.evidenceIndex.some((entry) =>
                request.candidate?.ref ? entry.ref === request.candidate.ref : false,
              ),
          )
          .map((packet) =>
            episodeFact(
              `lead-handoff:${packet.id}`,
              `Canonical handoff packet status=${packet.status} currentWriteOwner=${packet.currentWriteOwnerAgentId}.`,
            ),
          )
      : [];
  const claims = activityClaims(rows).filter((entry) => /hand.?back|handoff/iu.test(entry.summary));
  if (
    sources.handoff.status === "unavailable" ||
    sources.handoff.status === "stale" ||
    sources.handoff.status === "ambiguous"
  ) {
    return dimension(
      "unknown",
      packetFacts,
      claims,
      `Handoff source is ${sources.handoff.status}.`,
    );
  }
  if (packetFacts.length > 0) {
    return dimension(
      "unknown",
      packetFacts,
      claims,
      "Handoff matched only by objective or candidate reference; exact episode, assignment, and window lineage is unavailable.",
    );
  }
  if (claims.length > 0) {
    return dimension(
      "present",
      [],
      claims,
      "Handback is mentioned in activity but no canonical handoff packet matched this episode.",
    );
  }
  return dimension(
    "unobserved",
    [],
    [],
    "No canonical or claimed handback was observed for this episode.",
  );
}

function notebookRecordPointer(
  sources: AgentEpisodeReportSources,
  record: SupervisorNotebookRecord,
): string {
  return `notebook:${sources.notebook.location ?? "unknown"}#record:${record.recordId}`;
}

function matchingNotebookRecords(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
): readonly SupervisorNotebookRecord[] {
  if (sources.notebook.status !== "available" && sources.notebook.status !== "ambiguous") {
    return [];
  }
  return sources.notebook.records.filter(
    (record) => record.recordId === request.episodeId || record.episode === request.episodeId,
  );
}

function notebookRecordClaims(
  sources: AgentEpisodeReportSources,
  records: readonly SupervisorNotebookRecord[],
): EpisodeEvidenceEntry[] {
  return records.flatMap((record) => {
    const pointer = notebookRecordPointer(sources, record);
    return [
      episodeClaim(pointer, `Notebook observation recorded for episode '${record.episode}'.`),
      episodeClaim(
        pointer,
        `Notebook suspectedMechanism status=${record.suspectedMechanism.status}.`,
      ),
      episodeClaim(
        pointer,
        `Notebook outcome and recommendation are recorded claims, not acceptance receipts.`,
      ),
    ];
  });
}

function notebookRecordFacts(
  sources: AgentEpisodeReportSources,
  records: readonly SupervisorNotebookRecord[],
): EpisodeEvidenceEntry[] {
  return records.map((record) =>
    episodeFact(
      notebookRecordPointer(sources, record),
      `Schema-valid SupervisorNotebookRecord recordId=${record.recordId} currentEpisode=${record.currentEpisode} laterEffect=${record.laterEffect}.`,
    ),
  );
}

function laterEffectDimension(
  sources: AgentEpisodeReportSources,
  records: readonly SupervisorNotebookRecord[],
): { laterEffect: EpisodeDimension; outcome: EpisodeDimension } {
  if (sources.notebook.status !== "available") {
    return {
      laterEffect: dimension(
        "unknown",
        [],
        [],
        `Notebook source is ${sources.notebook.status}; later effect cannot be joined.`,
      ),
      outcome: dimension(
        "unknown",
        [],
        [],
        `Notebook source is ${sources.notebook.status}; outcome support remains unknown.`,
      ),
    };
  }
  if (records.length !== 1) {
    const status = "unknown";
    const facts = notebookRecordFacts(sources, records);
    const claims = notebookRecordClaims(sources, records);
    const inference =
      records.length === 0
        ? "No schema-valid notebook record identified this exact episode; record absence does not establish that later effect was absent or unobserved."
        : "Multiple records identify this episode; source join is ambiguous and is not collapsed.";
    return {
      laterEffect: dimension(status, facts, claims, inference),
      outcome: dimension(status, facts, claims, inference),
    };
  }
  const current = records[0]!;
  const laterEvidenceRefs = current.laterEffectEvidenceRefs;
  if (current.laterEffect !== "Observed" || laterEvidenceRefs.length === 0) {
    return {
      laterEffect: dimension(
        "unknown",
        [
          episodeFact(
            notebookRecordPointer(sources, current),
            `Notebook record states laterEffect=${current.laterEffect}; dedicated later refs=${laterEvidenceRefs.length}. This is a fact about the record, not a verdict that later effect was absent.`,
          ),
        ],
        notebookRecordClaims(sources, [current]),
        "Current-episode notebook append, laterEffect=Unobserved, missing refs, or source fixes do not establish whether a later comparable effect exists.",
      ),
      outcome: dimension(
        "unknown",
        [],
        notebookRecordClaims(sources, [current]),
        "Outcome support remains unknown until an actual later comparable episode is canonically joined; the current record's claim is not a verdict.",
      ),
    };
  }
  return {
    laterEffect: dimension(
      "unknown",
      [
        episodeFact(
          notebookRecordPointer(sources, current),
          "Notebook laterEffect=Observed is a claim with dedicated refs, not a canonical later-execution join.",
        ),
      ],
      notebookRecordClaims(sources, [current]),
      "Dedicated laterEffectEvidenceRefs are present, but this bounded source seam has no canonical comparable later-execution evidence; later effect remains unknown.",
    ),
    outcome: dimension(
      "unknown",
      [],
      notebookRecordClaims(sources, [current]),
      "An asserted laterEffect cannot support outcome without a canonical comparable later episode join.",
    ),
  };
}

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function candidateNotebookFacts(
  sources: AgentEpisodeReportSources,
  records: readonly SupervisorNotebookRecord[],
  candidateRef: string,
  refs: ReadonlySet<string>,
): EpisodeEvidenceEntry[] {
  return records.flatMap((record) => {
    const matched = record.evidence.some(
      (reference) => refs.has(reference) || reference.includes(candidateRef),
    );
    if (!matched) return [];
    // Notebook evidence is a persisted record claim. It can identify the
    // record that mentioned a candidate, but it is not an authoritative
    // artifact/receipt digest and must not validate a requested digest.
    return [
      episodeFact(
        notebookRecordPointer(sources, record),
        `Notebook evidence references candidate '${candidateRef}'.`,
      ),
    ];
  });
}

function candidateHandoffClaims(
  sources: AgentEpisodeReportSources,
  candidateRef: string,
  refs: ReadonlySet<string>,
): EpisodeEvidenceEntry[] {
  return sources.handoff.packets.flatMap((packet) =>
    packet.evidenceIndex.flatMap((entry) => {
      return refs.has(entry.ref) || entry.ref.includes(candidateRef)
        ? [
            episodeClaim(
              `lead-handoff:${packet.id}`,
              `Handoff evidence weakly claims candidate '${candidateRef}'; exact episode, assignment, and window lineage is unavailable.`,
            ),
          ]
        : [];
    }),
  );
}

function candidateActivityClaims(
  rows: readonly AgentTimelineRow[],
  candidateRef: string,
  refs: ReadonlySet<string>,
): EpisodeEvidenceEntry[] {
  return rows.flatMap((row) => {
    const searchable = timelineTextForClaimMatching(row.item);
    const pointer = timelinePointer(row);
    const matched =
      searchable.includes(candidateRef) ||
      refs.has(pointer) ||
      [...refs].some((reference) => searchable.includes(reference));
    if (!matched) return [];
    return [
      episodeClaim(
        pointer,
        `Activity content mentions candidate '${candidateRef}'; timeline text is a claim/request, not a verified candidate or artifact digest.`,
      ),
    ];
  });
}

function candidateCheckpointFacts(
  sources: AgentEpisodeReportSources,
  candidateRef: string,
  candidateDigest: string | undefined,
  observedDigests: Set<string>,
): EpisodeEvidenceEntry[] {
  return (sources.checkpoint?.evidence ?? []).flatMap((entry) => {
    const exactAssignmentPointer =
      entry.kind === "assignment" &&
      entry.pointer === candidateRef &&
      SHA256_DIGEST_PATTERN.test(entry.pointer) &&
      (candidateDigest === undefined || candidateDigest === entry.pointer);
    if (!exactAssignmentPointer) return [];
    // The structured assignment pointer is the authoritative digest. Never
    // parse a checkpoint summary: summaries can contain advisory narrative.
    observedDigests.add(entry.pointer);
    return [
      episodeFact(
        `checkpoint:${entry.kind}:${entry.pointer}`,
        `Typed assignment checkpoint pointer supports candidate digest '${candidateRef}'.`,
      ),
    ];
  });
}

function candidateCheckpointClaims(
  sources: AgentEpisodeReportSources,
  candidateRef: string,
  candidateDigest: string | undefined,
  refs: ReadonlySet<string>,
): EpisodeEvidenceEntry[] {
  return (sources.checkpoint?.evidence ?? []).flatMap((entry) => {
    const pointer = `checkpoint:${entry.kind}:${entry.pointer}`;
    const mentionsCandidate =
      entry.pointer === candidateRef ||
      entry.summary.includes(candidateRef) ||
      (candidateDigest !== undefined && entry.summary.includes(candidateDigest)) ||
      refs.has(pointer);
    const exactAssignmentPointer =
      entry.kind === "assignment" &&
      entry.pointer === candidateRef &&
      SHA256_DIGEST_PATTERN.test(entry.pointer) &&
      (candidateDigest === undefined || candidateDigest === entry.pointer);
    if (!mentionsCandidate || exactAssignmentPointer) return [];
    return [
      episodeClaim(
        pointer,
        `Checkpoint ${entry.kind} pointer/summary mentions candidate '${candidateRef}', but advisory narrative is not a verified candidate or artifact digest.`,
      ),
    ];
  });
}

interface CandidateEvidenceProjection {
  facts: EpisodeEvidenceEntry[];
  claims: EpisodeEvidenceEntry[];
  observedDigests: Set<string>;
  ambiguousJoin: boolean;
}

function candidateEvidence(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
  records: readonly SupervisorNotebookRecord[],
  rows: readonly AgentTimelineRow[],
): CandidateEvidenceProjection {
  const candidate = request.candidate;
  if (!candidate) {
    return { facts: [], claims: [], observedDigests: new Set(), ambiguousJoin: false };
  }
  const observedDigests = new Set<string>();
  const refs = new Set([candidate.ref, ...(candidate.evidenceRefs ?? [])]);
  const notebookFacts = candidateNotebookFacts(sources, records, candidate.ref, refs);
  const candidateActivityClaimEntries = candidateActivityClaims(rows, candidate.ref, refs);
  const checkpointFacts = candidateCheckpointFacts(
    sources,
    candidate.ref,
    candidate.digest,
    observedDigests,
  );
  const checkpointClaims = candidateCheckpointClaims(
    sources,
    candidate.ref,
    candidate.digest,
    refs,
  );
  const claims = [
    ...candidateHandoffClaims(sources, candidate.ref, refs),
    ...candidateActivityClaimEntries,
    ...checkpointClaims,
  ];
  const facts = [...notebookFacts, ...checkpointFacts];
  return {
    facts: uniqueEvidence(facts),
    claims: uniqueEvidence(claims),
    observedDigests,
    // Notebook records, handoffs, timeline text, and non-assignment checkpoint
    // narratives are claims without authoritative candidate provenance.
    ambiguousJoin: notebookFacts.length > 0 || claims.length > 0,
  };
}

function candidateEntrySourceUnknown(
  sources: AgentEpisodeReportSources,
  entry: EpisodeEvidenceEntry,
): boolean {
  if (entry.pointer.startsWith("timeline:")) {
    return sourceStatusUnknown(sources.activity.status);
  }
  if (entry.pointer.startsWith("notebook:")) {
    return sourceStatusUnknown(sources.notebook.status);
  }
  if (entry.pointer.startsWith("lead-handoff:")) {
    return sourceStatusUnknown(sources.handoff.status);
  }
  return false;
}

function candidateLineage(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
  records: readonly SupervisorNotebookRecord[],
  rows: readonly AgentTimelineRow[],
): EpisodeLineageField {
  const candidate = request.candidate;
  if (!candidate) {
    return lineage(
      null,
      null,
      "missing",
      [],
      [],
      "No candidate identity was supplied for this bounded report.",
    );
  }
  const evidence = candidateEvidence(sources, request, records, rows);
  const sourceUnknown =
    sourceStatusUnknown(sources.activity.status) ||
    sourceStatusUnknown(sources.notebook.status) ||
    sourceStatusUnknown(sources.handoff.status);
  const evidenceSourceUnknown = [...evidence.facts, ...evidence.claims].some((entry) =>
    candidateEntrySourceUnknown(sources, entry),
  );
  if (candidate.digest && !evidence.observedDigests.has(candidate.digest)) {
    return lineage(
      candidate.ref,
      null,
      "unknown",
      evidence.facts,
      evidence.claims,
      `candidate_mismatch: requested digest ${candidate.digest} was not observed in candidate-linked evidence.`,
    );
  }
  if (evidence.facts.length === 0 && evidence.claims.length === 0) {
    return lineage(
      candidate.ref,
      null,
      sourceUnknown ? "unknown" : "unobserved",
      [],
      [],
      sourceUnknown
        ? "Candidate sources are unavailable, stale, or ambiguous; candidate lineage remains unknown."
        : "Candidate identity was requested but no source referenced it.",
    );
  }
  if (evidenceSourceUnknown) {
    return lineage(
      candidate.ref,
      candidate.ref,
      "unknown",
      evidence.facts,
      evidence.claims,
      "Candidate evidence was found, but one or more bounded sources are missing, stale, unavailable, or ambiguous.",
    );
  }
  const definitiveFacts = evidence.facts.filter(
    (entry) => entry.pointer.startsWith("timeline:") || entry.pointer.startsWith("checkpoint:"),
  );
  if (evidence.ambiguousJoin && definitiveFacts.length === 0) {
    return lineage(
      candidate.ref,
      candidate.ref,
      "unknown",
      evidence.facts,
      evidence.claims,
      "Candidate reference is only joined through notebook, handoff, freeform activity, or advisory checkpoint claims without exact assignment and episode-window lineage.",
    );
  }
  return lineage(
    candidate.ref,
    candidate.ref,
    "present",
    evidence.facts,
    evidence.claims,
    "Candidate reference is source-linked; candidate content and acceptance remain outside this report's authority.",
  );
}

function evidenceLineage(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
  candidate: EpisodeLineageField,
  records: readonly SupervisorNotebookRecord[],
  rows: readonly AgentTimelineRow[],
): EpisodeLineageField {
  const requested = request.candidate?.evidenceRefs ?? [];
  const sourceRefs = new Set<string>();
  for (const record of records) for (const ref of record.evidence) sourceRefs.add(ref);
  for (const row of rows) sourceRefs.add(timelinePointer(row));
  const facts = [...notebookRecordFacts(sources, records), ...activitySourceFacts(rows)];
  const matched = requested.filter((ref) => sourceRefs.has(ref));
  if (requested.length > 0 && matched.length !== requested.length) {
    return lineage(
      requested.join(","),
      matched.length > 0 ? matched.join(",") : null,
      "unknown",
      facts,
      candidate.claims,
      "One or more requested evidence references could not be joined to the bounded sources.",
    );
  }
  if (facts.length === 0) {
    return lineage(
      requested.length > 0 ? requested.join(",") : null,
      null,
      requested.length > 0 ? "unknown" : "unobserved",
      [],
      [],
      requested.length > 0
        ? "Requested evidence references were not observed."
        : "No bounded source evidence was observed for this episode.",
    );
  }
  return lineage(
    requested.length > 0 ? requested.join(",") : null,
    matched.length > 0 ? matched.join(",") : "bounded-sources",
    "present",
    facts,
    candidate.claims,
    "Evidence lineage lists source pointers; it does not turn claims into acceptance.",
  );
}

interface EpisodeIdentityProjection {
  assignmentDigest: string | null;
  projectFacts: EpisodeEvidenceEntry[];
  assignmentFacts: EpisodeEvidenceEntry[];
  issue: CheckpointBeadsIssueSnapshot | null;
  issueFacts: EpisodeEvidenceEntry[];
  projectMatches: boolean;
  assignmentMatches: boolean;
  issueMatches: boolean;
}

function projectEpisodeIdentity(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
): EpisodeIdentityProjection {
  const assignment = sources.assignment;
  const projectSource = sources.project;
  const assignmentDigest = assignment?.receipt.assignmentDigest ?? null;
  const projectFacts =
    projectSource.status === "available" && projectSource.projectId
      ? [
          episodeFact(
            `project:${projectSource.projectId}`,
            `Registered project ${projectSource.projectId} is bound to workspace ${projectSource.workspaceId ?? "unknown"}.`,
          ),
        ]
      : [];
  const assignmentFacts = assignment
    ? [
        episodeFact(
          `assignment:${assignment.receipt.assignmentDigest}`,
          `Pinned ${assignment.roleId} assignment receipt effect=${assignment.effectClass}.`,
        ),
      ]
    : [];
  const issue = sources.beads.accessible ? sources.beads.issue : null;
  const issueFacts = issue
    ? [
        episodeFact(
          `beads:${issue.issueId}`,
          `Exact Beads issue status=${issue.status} assignee=${issue.assigneeAgentId ?? "none"}.`,
        ),
      ]
    : [];
  return {
    assignmentDigest,
    projectFacts,
    assignmentFacts,
    issue,
    issueFacts,
    projectMatches:
      projectSource.status === "available" && projectSource.projectId === request.projectId,
    assignmentMatches: Boolean(
      assignment &&
      assignmentDigest === request.assignmentDigest &&
      assignment.objective === request.objective,
    ),
    issueMatches: issue?.issueId === request.issueId,
  };
}

function identityUnknowns(
  sources: AgentEpisodeReportSources,
  identity: EpisodeIdentityProjection,
): string[] {
  const unknowns: string[] = [];
  if (!identity.projectMatches) {
    unknowns.push(
      "episode_project_mismatch_or_unavailable: requested project is not the trusted target project",
    );
  }
  if (!identity.assignmentMatches) {
    unknowns.push(
      "episode_assignment_mismatch_or_unavailable: requested assignment digest/objective is not the trusted target assignment",
    );
  }
  if (!identity.issueMatches) {
    unknowns.push(
      "episode_issue_mismatch_or_unavailable: requested issue is not the exact target-bound Beads issue",
    );
  }
  if (sources.beads.accessible && identity.issue && !identity.issue.dependencyDataComplete) {
    unknowns.push(
      `beads_dependencies_incomplete: issue ${identity.issue.issueId} dependency state remains unknown`,
    );
  }
  return unknowns;
}

function causalEpisodeDimension(
  sources: AgentEpisodeReportSources,
  records: readonly SupervisorNotebookRecord[],
): EpisodeDimension {
  const facts = notebookRecordFacts(sources, records);
  const claims = notebookRecordClaims(sources, records);
  if (sources.notebook.status !== "available") {
    return dimension(
      "unknown",
      facts,
      claims,
      `Notebook source is ${sources.notebook.status}; causal/disproof record is unavailable.`,
    );
  }
  if (records.length === 0) {
    return dimension(
      "unobserved",
      [],
      [],
      "No exact SupervisorNotebookRecord matched this episode.",
    );
  }
  if (records.length > 1) {
    return dimension(
      "unknown",
      facts,
      claims,
      "Contradictory/ambiguous records are preserved and not collapsed.",
    );
  }
  const record = records[0]!;
  return dimension(
    "present",
    facts,
    claims,
    `suspectedMechanism=${record.suspectedMechanism.status}; patternStatus=${record.patternStatus}; no automatic learning or rule promotion is performed.`,
  );
}

function activityEpisodeStatus(
  sources: AgentEpisodeReportSources,
  rows: readonly AgentTimelineRow[],
): EpisodeDimension["status"] {
  if (sourceStatusUnknown(sources.activity.status) || sources.activity.truncated) return "unknown";
  return rows.length > 0 ? "exercised" : "unobserved";
}

function episodeSourceFacts(input: {
  identity: EpisodeIdentityProjection;
  candidate: EpisodeDimension;
  evidence: EpisodeDimension;
  testPass: EpisodeDimension;
  delivery: EpisodeDimension;
  handback: EpisodeDimension;
  laterEffect: EpisodeDimension;
  causal: EpisodeDimension;
}): EpisodeEvidenceEntry[] {
  return uniqueEvidence([
    ...input.identity.projectFacts,
    ...input.identity.assignmentFacts,
    ...input.identity.issueFacts,
    ...input.candidate.sourceFacts,
    ...input.evidence.sourceFacts,
    ...input.testPass.sourceFacts,
    ...input.delivery.sourceFacts,
    ...input.handback.sourceFacts,
    ...input.laterEffect.sourceFacts,
    ...input.causal.sourceFacts,
  ]);
}

function episodeClaims(input: {
  candidate: EpisodeDimension;
  evidence: EpisodeDimension;
  testPass: EpisodeDimension;
  delivery: EpisodeDimension;
  handback: EpisodeDimension;
  laterEffect: EpisodeDimension;
  causal: EpisodeDimension;
}): EpisodeEvidenceEntry[] {
  return uniqueEvidence([
    ...input.candidate.claims,
    ...input.evidence.claims,
    ...input.testPass.claims,
    ...input.delivery.claims,
    ...input.handback.claims,
    ...input.laterEffect.claims,
    ...input.causal.claims,
  ]);
}

function buildEpisodeDimensions(input: {
  sources: AgentEpisodeReportSources;
  identity: EpisodeIdentityProjection;
  rows: readonly AgentTimelineRow[];
  evidence: EpisodeDimension;
  testPass: EpisodeDimension;
  delivery: EpisodeDimension;
  handback: EpisodeDimension;
  laterEffect: EpisodeDimension;
  outcome: EpisodeDimension;
  causal: EpisodeDimension;
  claims: readonly EpisodeEvidenceEntry[];
}): AgentEpisodeReport["dimensions"] {
  return {
    wiring: dimension(
      input.identity.projectMatches &&
        input.identity.assignmentMatches &&
        input.identity.issueMatches
        ? "wired"
        : "unknown",
      [
        ...input.identity.projectFacts,
        ...input.identity.assignmentFacts,
        ...input.identity.issueFacts,
      ],
      [],
      EPISODE_UNKNOWN,
    ),
    activity: dimension(
      activityEpisodeStatus(input.sources, input.rows),
      activitySourceFacts(input.rows),
      activityClaims(input.rows),
      "Activity proves only bounded exercise; it does not prove outcome or acceptance.",
    ),
    evidence: input.evidence,
    testPass: input.testPass,
    delivery: input.delivery,
    handback: input.handback,
    leadAcceptance: dimension(
      "unobserved",
      [],
      input.claims,
      "Reported test pass, delivery, handback, lifecycle, or Council activity is not a Lead acceptance receipt.",
    ),
    outcome: input.outcome,
    laterEffect: input.laterEffect,
    causalInterpretation: input.causal,
  };
}

function buildEpisodeLineage(input: {
  sources: AgentEpisodeReportSources;
  request: EpisodeReportRequest;
  identity: EpisodeIdentityProjection;
  candidate: EpisodeLineageField;
  evidence: EpisodeLineageField;
}): AgentEpisodeReport["lineage"] {
  const { request, identity, sources } = input;
  return {
    project: lineage(
      request.projectId,
      sources.project.projectId,
      identity.projectMatches ? "present" : "unknown",
      identity.projectFacts,
      [],
      identity.projectMatches
        ? "Trusted project identity matches the explicit report request."
        : "Project identity mismatch or source unavailable; do not read this report as cross-project evidence.",
    ),
    assignment: lineage(
      request.assignmentDigest,
      identity.assignmentDigest,
      identity.assignmentMatches ? "wired" : "unknown",
      identity.assignmentFacts,
      [],
      identity.assignmentMatches
        ? "Pinned assignment digest and objective match the explicit request."
        : "Assignment digest/objective mismatch remains unknown.",
    ),
    issue: lineage(
      request.issueId,
      identity.issue?.issueId ?? null,
      identity.issueMatches ? "present" : "unknown",
      identity.issueFacts,
      [],
      identity.issueMatches
        ? "Exact target-bound Beads issue was read through the existing adapter."
        : "Exact issue binding was not established.",
    ),
    candidate: input.candidate,
    evidence: input.evidence,
  };
}

function projectEpisodeReport(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
): AgentEpisodeReport {
  const identity = projectEpisodeIdentity(sources, request);
  const unknowns = identityUnknowns(sources, identity);
  const records = matchingNotebookRecords(sources, request);
  if (sources.notebook.parseErrors > 0) {
    unknowns.push(
      `notebook_records_ambiguous: ${sources.notebook.parseErrors} record marker(s) could not be schema-validate`,
    );
  }
  const rows = episodeActivityRows(sources, request);
  if (sources.activity.truncated) {
    unknowns.push("activity_window_truncated: bounded activity read may omit older rows");
  }
  const candidate = candidateLineage(sources, request, records, rows);
  if (candidate.inference?.includes("candidate_mismatch")) unknowns.push(candidate.inference);
  const evidence = evidenceLineage(sources, request, candidate, records, rows);
  const testPass = testPassDimension(sources, rows);
  const delivery = deliveryDimension(sources, rows);
  const handback = handbackDimension(sources, request, rows);
  const later = laterEffectDimension(sources, records);
  const causal = causalEpisodeDimension(sources, records);
  const claims = episodeClaims({
    candidate,
    evidence,
    testPass,
    delivery,
    handback,
    laterEffect: later.laterEffect,
    causal,
  });
  const sourceFacts = episodeSourceFacts({
    identity,
    candidate,
    evidence,
    testPass,
    delivery,
    handback,
    laterEffect: later.laterEffect,
    causal,
  });
  const dimensions = buildEpisodeDimensions({
    sources,
    identity,
    rows,
    evidence,
    testPass,
    delivery,
    handback,
    laterEffect: later.laterEffect,
    outcome: later.outcome,
    causal,
    claims,
  });
  const status =
    sources.relationshipToTarget === "unrelated" ||
    !identity.projectMatches ||
    !identity.assignmentMatches ||
    !identity.issueMatches
      ? "unknown"
      : "reportable";
  if (sources.notebook.status !== "available") {
    unknowns.push(
      `notebook_source_${sources.notebook.status}: ${sources.notebook.reason ?? "source is not available"}`,
    );
  }
  if (sources.activity.status !== "available") {
    unknowns.push(
      `activity_source_${sources.activity.status}: ${sources.activity.reason ?? "source is not available"}`,
    );
  }
  return {
    schemaVersion: 1,
    episodeId: request.episodeId,
    status,
    lineage: buildEpisodeLineage({ sources, request, identity, candidate, evidence }),
    dimensions,
    notebook: {
      status: sources.notebook.status,
      location: sources.notebook.location,
      matchedRecordIds: records.map((record) => record.recordId),
      records,
    },
    sourceFacts,
    claims,
    inferences: [
      EPISODE_UNKNOWN,
      "A session, issue, or current notebook append is not automatically an episode or a later comparable effect.",
      "No automatic Workspace Protocol or rule promotion is performed.",
    ],
    unknowns,
    authority: {
      reportMayGrantWriter: false,
      reportMayMutateBeads: false,
      reportMayAccept: false,
      reportMayPromoteRule: false,
    },
  };
}

/** SLP interpretation for the generic bounded episode-report host. */
export const SLP_EPISODE_REPORT_POLICY: EpisodeReportPolicy = {
  id: "slp",
  version: "1",
  project: projectEpisodeReport,
};

export const SLP_CHECKPOINT_POLICY: CheckpointPolicy = {
  id: "slp",
  version: SLP_CHECKPOINT_POLICY_VERSION,
  project,
  episodeReport: SLP_EPISODE_REPORT_POLICY,
};
