import { describe, expect, it } from "vitest";
import type { AssignmentContractReceipt } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import type {
  AgentCheckpointSources,
  CheckpointCallerContext,
  CheckpointCouncilSnapshot,
  CheckpointRoleActor,
} from "../../../agent/agent-checkpoint.js";
import { SLP_CHECKPOINT_POLICY } from "./checkpoint-policy.js";

function assignmentFixture(
  overrides: Partial<AssignmentContractReceipt> = {},
): AssignmentContractReceipt {
  return {
    version: 1,
    assignmentDigest: "b".repeat(64),
    roleId: "peer",
    disposition: "peer-execution",
    assigner: { kind: "human-session" },
    workspaceId: "workspace-1",
    cwd: "/tmp/workspace-1",
    effectClass: "mutating",
    mutationBoundary: { mode: "bounded-write", scope: "only new files" },
    externalEffectBoundary: { mode: "denied" },
    createdAt: "2026-09-06T10:00:00.000Z",
    ...overrides,
  };
}

function actorFixture(
  roleId: PaseoRoleId | null,
  overrides: Partial<CheckpointRoleActor> = {},
): CheckpointRoleActor {
  return {
    agentId: "agent-1",
    roleId,
    assignment: null,
    ...overrides,
  };
}

/** Convenience for tests that must pass the live-grant gate to reach role/ceiling logic. */
function withCurrentAssignment(roleId: PaseoRoleId): AssignmentContractReceipt {
  return assignmentFixture({ roleId });
}

function callerContextFixture(
  overrides: Partial<CheckpointCallerContext> = {},
): CheckpointCallerContext {
  return {
    relationshipToTarget: "self",
    allowedActions: [
      "continue_bounded_work",
      "handback_with_evidence",
      "request_status_update",
      "flag_to_human",
    ],
    ...overrides,
  };
}

function sourcesFixture(overrides: Partial<AgentCheckpointSources> = {}): AgentCheckpointSources {
  return {
    now: new Date("2026-09-06T12:00:00.000Z"),
    caller: actorFixture("peer"),
    target: actorFixture("peer"),
    readAuthorization: { authorized: true, reason: "same agent" },
    callerContext: callerContextFixture(),
    targetLifecycle: "idle",
    pendingPermission: null,
    coordinationSignals: [],
    council: null,
    beads: { accessible: true, issue: null },
    ...overrides,
  };
}

describe("SLP_CHECKPOINT_POLICY: no-source disposition", () => {
  it("reports 'unknown' (not 'done') when the target is idle with no other evidence", () => {
    const result = SLP_CHECKPOINT_POLICY.project(sourcesFixture());
    expect(result.disposition).toBe("unknown");
    expect(result.unknowns.some((entry) => entry.startsWith("no_disposition_source"))).toBe(true);
  });

  it("reports 'no-outstanding-dependency' once at least one real source clears with no wait", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-1",
            status: "in_progress",
            assigneeAgentId: "agent-1",
            openDependencyCount: 0,
            boundTargetAgentId: "agent-1",
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(result.disposition).toBe("no-outstanding-dependency");
    expect(result.waitingOn).toEqual([]);
  });
});

describe("SLP_CHECKPOINT_POLICY: assignment grant states", () => {
  it("labels a current grant distinctly from a missing one", () => {
    const withGrant = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({ caller: actorFixture("lead", { assignment: assignmentFixture() }) }),
    );
    const assignmentEvidence = withGrant.evidence.find((entry) => entry.kind === "assignment");
    expect(assignmentEvidence?.summary).toContain("grant=current");

    const withoutGrant = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({ caller: actorFixture("lead", { assignment: null }) }),
    );
    expect(withoutGrant.evidence.some((entry) => entry.kind === "assignment")).toBe(false);
  });

  it("labels an expired grant as 'expired', distinct from 'current'", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("lead", {
          assignment: assignmentFixture({ expiresAt: "2026-09-06T08:00:00.000Z" }),
        }),
      }),
    );
    const assignmentEvidence = result.evidence.find((entry) => entry.kind === "assignment");
    expect(assignmentEvidence?.summary).toContain("grant=expired");
  });
});

describe("SLP_CHECKPOINT_POLICY: negative authority gates allowedNextSteps, not role name", () => {
  const withOutstandingWait = {
    pendingPermission: { key: "perm-1", requestedAt: null },
  };

  it("an expired caller grant yields only a read step, never continue/request/flag actions", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("lead", {
          assignment: assignmentFixture({ expiresAt: "2026-09-06T08:00:00.000Z" }),
        }),
      }),
    );
    expect(result.allowedNextSteps).toEqual([
      expect.objectContaining({
        action: "read_evidence",
        rationale: expect.stringContaining("expired"),
      }),
    ]);
  });

  it("a missing caller grant (null assignment) yields only a read step", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("peer", { assignment: null }),
      }),
    );
    expect(result.allowedNextSteps).toEqual([
      expect.objectContaining({
        action: "read_evidence",
        rationale: expect.stringContaining("missing"),
      }),
    ]);
  });

  it("an unrelated caller-target relationship yields only a read step even with a current grant", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("supervisor", { assignment: withCurrentAssignment("supervisor") }),
        callerContext: callerContextFixture({ relationshipToTarget: "unrelated" }),
      }),
    );
    expect(result.allowedNextSteps).toEqual([
      expect.objectContaining({
        action: "observe_only",
        rationale: expect.stringContaining("no authorized ownership/observation relationship"),
      }),
    ]);
  });

  it("a current grant + owning relationship but an empty tool-ceiling still yields only a read step", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("lead", { assignment: withCurrentAssignment("lead") }),
        callerContext: callerContextFixture({ allowedActions: [] }),
      }),
    );
    expect(result.allowedNextSteps.map((step) => step.action)).toEqual(["read_evidence"]);
  });

  it("a null tool-ceiling (adapter did not resolve one) fails closed to read-only", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("peer", { assignment: withCurrentAssignment("peer") }),
        callerContext: callerContextFixture({ allowedActions: null }),
      }),
    );
    expect(result.allowedNextSteps.map((step) => step.action)).toEqual(["read_evidence"]);
  });

  it("granting the exact ceiling action restores it for Lead, still bounded by an outstanding wait", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("lead", { assignment: withCurrentAssignment("lead") }),
        callerContext: callerContextFixture({ allowedActions: ["request_status_update"] }),
      }),
    );
    expect(result.allowedNextSteps.map((step) => step.action)).toEqual([
      "read_evidence",
      "request_status_update",
    ]);
  });

  it("Peer's continue_bounded_work does not require an outstanding wait, only the ceiling", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("peer", { assignment: withCurrentAssignment("peer") }),
        callerContext: callerContextFixture({ allowedActions: ["continue_bounded_work"] }),
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-3",
            status: "in_progress",
            assigneeAgentId: "agent-1",
            openDependencyCount: 0,
            boundTargetAgentId: "agent-1",
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(result.allowedNextSteps.map((step) => step.action)).toEqual([
      "read_evidence",
      "continue_bounded_work",
    ]);
  });

  it("Supervisor's flag_to_human requires both the ceiling and an outstanding wait", () => {
    const noWait = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("supervisor", { assignment: withCurrentAssignment("supervisor") }),
        callerContext: callerContextFixture({ allowedActions: ["flag_to_human"] }),
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-4",
            status: "in_progress",
            assigneeAgentId: "agent-1",
            openDependencyCount: 0,
            boundTargetAgentId: "agent-1",
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(noWait.allowedNextSteps.map((step) => step.action)).toEqual(["observe_only"]);

    const withWait = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture("supervisor", { assignment: withCurrentAssignment("supervisor") }),
        callerContext: callerContextFixture({ allowedActions: ["flag_to_human"] }),
      }),
    );
    expect(withWait.allowedNextSteps.map((step) => step.action)).toEqual([
      "observe_only",
      "flag_to_human",
    ]);
  });

  it("unknown disposition overrides every gate: only 'gather_missing_evidence' is offered", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("lead", { assignment: withCurrentAssignment("lead") }),
      }),
    );
    expect(result.disposition).toBe("unknown");
    expect(result.allowedNextSteps).toEqual([
      expect.objectContaining({ action: "gather_missing_evidence" }),
    ]);
  });

  it("an unbound caller role receives only the read-evidence step", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        ...withOutstandingWait,
        caller: actorFixture(null, { assignment: null }),
      }),
    );
    expect(result.allowedNextSteps.map((step) => step.action)).toEqual(["read_evidence"]);
  });
});

describe("SLP_CHECKPOINT_POLICY: pending permission", () => {
  it("waits on 'human' and surfaces the permission key as evidence", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        pendingPermission: { key: "perm-1", requestedAt: "2026-09-06T11:00:00.000Z" },
      }),
    );
    expect(result.waitingOn).toEqual([
      expect.objectContaining({
        actor: { kind: "human" },
        reason: expect.stringContaining("perm-1"),
      }),
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({ kind: "pending-permission", pointer: "perm-1" }),
    ]);
  });
});

describe("SLP_CHECKPOINT_POLICY: Beads disposition is honest, not existence-based", () => {
  it("reports an unknown, not a fabricated snapshot, when Beads is inaccessible", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({ beads: { accessible: false, reason: "Beads Central unavailable" } }),
    );
    expect(result.evidence.some((entry) => entry.kind === "beads")).toBe(false);
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("beads_inaccessible")]),
    );
  });

  it("waits on an unknown actor when the Beads issue is blocked by open dependencies", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-2",
            status: "blocked",
            assigneeAgentId: "agent-1",
            openDependencyCount: 2,
            boundTargetAgentId: "agent-1",
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(result.waitingOn).toEqual([expect.objectContaining({ actor: { kind: "unknown" } })]);
    expect(result.disposition).toBe("waiting-on-other");
  });

  it("a bare 'open' issue with no assignee is not a disposition source (ambiguous, not known)", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-5",
            status: "open",
            assigneeAgentId: null,
            openDependencyCount: 0,
            boundTargetAgentId: null,
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(result.disposition).toBe("unknown");
    expect(result.evidence.some((entry) => entry.kind === "beads")).toBe(true);
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("no_disposition_source")]),
    );
  });

  it("a claimed-but-not-started 'open' issue (assignee set, still open) stays unknown", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-6",
            status: "open",
            assigneeAgentId: "agent-1",
            openDependencyCount: 0,
            boundTargetAgentId: null,
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(result.disposition).toBe("unknown");
  });

  it("a closed issue is a concrete disposition source", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        beads: {
          accessible: true,
          issue: {
            issueId: "iss-7",
            status: "closed",
            assigneeAgentId: "agent-1",
            openDependencyCount: 0,
            boundTargetAgentId: "agent-1",
            dependencyDataComplete: true,
          },
        },
      }),
    );
    expect(result.disposition).toBe("no-outstanding-dependency");
  });
});

describe("SLP_CHECKPOINT_POLICY: Council canonical receipts and mixed collection state", () => {
  function councilFixture(
    overrides: Partial<CheckpointCouncilSnapshot> = {},
  ): CheckpointCouncilSnapshot {
    return {
      caseId: "case-1",
      phase: "review",
      parentAgentId: "lead-1",
      seats: [
        {
          role: "architect",
          agentId: "agent-1",
          phase: "review",
          integrity: "valid",
          hasReportReceipt: true,
          reportReceiptPointer: "msg-architect-1",
          disposition: "recommend option A",
        },
        {
          role: "reviewer",
          agentId: "agent-2",
          phase: "sealed",
          integrity: "unspecified",
          hasReportReceipt: false,
          reportReceiptPointer: null,
          disposition: null,
        },
      ],
      ...overrides,
    };
  }

  it("flags a seat with missing canonical disposition as an unknown, not a silent pass", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        council: councilFixture({
          seats: [
            {
              role: "architect",
              agentId: "agent-1",
              phase: "sealed",
              integrity: "missing",
              hasReportReceipt: false,
              reportReceiptPointer: null,
              disposition: null,
            },
          ],
        }),
      }),
    );
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("council_seat_architect_integrity_missing")]),
    );
  });

  it("Lead (case owner) waits on the lagging seat by agent id, using seat-level report state", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("lead", { agentId: "lead-1" }),
        target: actorFixture("lead", { agentId: "lead-1" }),
        council: councilFixture(),
      }),
    );
    expect(result.waitingOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: { kind: "agent", agentId: "agent-2", roleId: null } }),
      ]),
    );
    // The reporting seat itself must not appear as something the Lead is waiting on.
    expect(
      result.waitingOn.some(
        (entry) => "agentId" in entry.actor && entry.actor.agentId === "agent-1",
      ),
    ).toBe(false);
  });

  it("a reporting seat waits on the Lead, citing its own canonical report pointer as evidence", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("peer", { agentId: "agent-1" }),
        target: actorFixture("peer", { agentId: "agent-1" }),
        council: councilFixture(),
      }),
    );
    expect(result.waitingOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: { kind: "agent", agentId: "lead-1", roleId: "lead" } }),
      ]),
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "council", pointer: "msg-architect-1" }),
      ]),
    );
  });

  it("does not keep a verdict seat waiting after its canonical disposition is recorded", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("peer", { agentId: "agent-1" }),
        target: actorFixture("peer", { agentId: "agent-1" }),
        council: councilFixture({
          phase: "verdict",
          seats: [
            {
              role: "architect",
              agentId: "agent-1",
              phase: "verdict",
              integrity: "valid",
              hasReportReceipt: true,
              reportReceiptPointer: "msg-architect-verdict",
              disposition: "accepted",
            },
          ],
        }),
      }),
    );
    expect(result.waitingOn).toEqual([]);
    expect(result.disposition).toBe("no-outstanding-dependency");
  });

  it("keeps a recorded failure on a compromised seat unknown without waiting on that seat", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("lead", { agentId: "lead-1" }),
        target: actorFixture("lead", { agentId: "lead-1" }),
        council: councilFixture({
          seats: [
            {
              role: "architect",
              agentId: "agent-1",
              phase: "verdict",
              integrity: "compromised",
              hasReportReceipt: false,
              reportReceiptPointer: null,
              disposition: "failed validation",
            },
          ],
        }),
      }),
    );
    expect(result.waitingOn).toEqual([]);
    expect(result.disposition).toBe("unknown");
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("integrity_compromised")]),
    );
  });

  it("a seat that has not yet reported makes no council-based waiting claim", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("peer", { agentId: "agent-2" }),
        target: actorFixture("peer", { agentId: "agent-2" }),
        council: councilFixture(),
      }),
    );
    expect(result.waitingOn).toEqual([]);
    expect(result.disposition).toBe("unknown");
  });

  it("does not treat case-level phase='verdict' as full collection when only one seat actually reported", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("lead", { agentId: "lead-1" }),
        target: actorFixture("lead", { agentId: "lead-1" }),
        council: councilFixture({
          phase: "verdict",
          seats: [
            {
              role: "architect",
              agentId: "agent-1",
              phase: "verdict",
              integrity: "valid",
              hasReportReceipt: true,
              reportReceiptPointer: "msg-architect-1",
              disposition: "recommend option A",
            },
            {
              role: "reviewer",
              agentId: "agent-2",
              phase: "sealed",
              integrity: "unspecified",
              hasReportReceipt: false,
              reportReceiptPointer: null,
              disposition: null,
            },
          ],
        }),
      }),
    );
    expect(result.waitingOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: { kind: "agent", agentId: "agent-2", roleId: null } }),
      ]),
    );
  });

  it("a target unrelated to the case (not owner, not a seat) gets no council-based claim", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        caller: actorFixture("peer", { agentId: "agent-9" }),
        target: actorFixture("peer", { agentId: "agent-9" }),
        council: councilFixture(),
      }),
    );
    expect(result.waitingOn).toEqual([]);
  });
});

describe("SLP_CHECKPOINT_POLICY: coordination signals stay advisory", () => {
  it("waits on 'self' for a pending signal, never transferring authority", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        coordinationSignals: [
          {
            id: "sig-1",
            targetAgentId: "agent-1",
            requestedByAgentId: null,
            kind: "continuity_attention",
            reason: "context pressure rising",
            evidenceRefs: [],
            status: "pending",
            createdAt: "2026-09-06T11:00:00.000Z",
            deliveredAt: null,
            resolvedAt: null,
          },
        ],
      }),
    );
    expect(result.waitingOn).toEqual([expect.objectContaining({ actor: { kind: "self" } })]);
  });

  it("lists a resolved-only signal as audit evidence but treats it as no disposition (stays unknown)", () => {
    const result = SLP_CHECKPOINT_POLICY.project(
      sourcesFixture({
        coordinationSignals: [
          {
            id: "sig-2",
            targetAgentId: "agent-1",
            requestedByAgentId: null,
            kind: "handoff_recommended",
            reason: "resolved earlier",
            evidenceRefs: [],
            status: "acknowledged",
            createdAt: "2026-09-06T11:00:00.000Z",
            deliveredAt: "2026-09-06T11:05:00.000Z",
            resolvedAt: "2026-09-06T11:10:00.000Z",
          },
        ],
      }),
    );
    expect(result.waitingOn).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({ kind: "coordination-signal", pointer: "sig-2" }),
    ]);
    expect(result.disposition).toBe("unknown");
    expect(result.unknowns).toEqual(
      expect.arrayContaining([expect.stringContaining("no_disposition_source")]),
    );
  });
});

describe("SLP_CHECKPOINT_POLICY: purity", () => {
  it("does not mutate its input and is deterministic across repeated calls", () => {
    const sources = sourcesFixture({
      council: {
        caseId: "case-1",
        phase: "review",
        parentAgentId: "lead-1",
        seats: [
          {
            role: "architect",
            agentId: "agent-1",
            phase: "review",
            integrity: "valid",
            hasReportReceipt: true,
            reportReceiptPointer: "msg-architect-1",
            disposition: "recommend option A",
          },
        ],
      },
    });
    const snapshotBefore = JSON.parse(
      JSON.stringify({ ...sources, now: sources.now.toISOString() }),
    );

    const first = SLP_CHECKPOINT_POLICY.project(sources);
    const second = SLP_CHECKPOINT_POLICY.project(sources);

    const snapshotAfter = JSON.parse(
      JSON.stringify({ ...sources, now: sources.now.toISOString() }),
    );
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(first).toEqual(second);
  });
});
