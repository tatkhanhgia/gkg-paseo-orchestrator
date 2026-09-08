import { describe, expect, it } from "vitest";
import type { AssignmentContractReceipt } from "@getpaseo/protocol/assignment-contract";

import {
  buildAgentCheckpoint,
  resolveAssignmentGrantState,
  type AgentCheckpointResult,
  type AgentCheckpointSources,
  type CheckpointPolicy,
  type CheckpointRoleActor,
} from "./agent-checkpoint.js";

function assignmentFixture(
  overrides: Partial<AssignmentContractReceipt> = {},
): AssignmentContractReceipt {
  return {
    version: 1,
    assignmentDigest: "a".repeat(64),
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

function actorFixture(overrides: Partial<CheckpointRoleActor> = {}): CheckpointRoleActor {
  return {
    agentId: "agent-1",
    roleId: "peer",
    assignment: null,
    ...overrides,
  };
}

function sourcesFixture(overrides: Partial<AgentCheckpointSources> = {}): AgentCheckpointSources {
  return {
    now: new Date("2026-09-06T12:00:00.000Z"),
    caller: actorFixture(),
    target: actorFixture(),
    readAuthorization: { authorized: true, reason: "same agent" },
    callerContext: { relationshipToTarget: "self", allowedActions: [] },
    targetLifecycle: "idle",
    pendingPermission: null,
    coordinationSignals: [],
    council: null,
    beads: { accessible: true, issue: null },
    ...overrides,
  };
}

const STUB_RESULT: AgentCheckpointResult = {
  agentId: "agent-1",
  disposition: "no-outstanding-dependency",
  waitingOn: [],
  evidence: [],
  allowedNextSteps: [],
  unknowns: [],
};

function stubPolicy(onProject?: (sources: AgentCheckpointSources) => void): CheckpointPolicy {
  return {
    id: "stub",
    version: "0",
    project(sources) {
      onProject?.(sources);
      return STUB_RESULT;
    },
  };
}

describe("resolveAssignmentGrantState", () => {
  it("reports 'missing' when there is no assignment receipt", () => {
    expect(resolveAssignmentGrantState(null, new Date("2026-09-06T12:00:00.000Z"))).toBe("missing");
  });

  it("reports 'current' when there is no expiry", () => {
    const assignment = assignmentFixture();
    expect(resolveAssignmentGrantState(assignment, new Date("2026-09-06T12:00:00.000Z"))).toBe(
      "current",
    );
  });

  it("reports 'current' when expiry is still in the future", () => {
    const assignment = assignmentFixture({ expiresAt: "2026-09-06T20:00:00.000Z" });
    expect(resolveAssignmentGrantState(assignment, new Date("2026-09-06T12:00:00.000Z"))).toBe(
      "current",
    );
  });

  it("reports 'expired' once the expiry has passed", () => {
    const assignment = assignmentFixture({ expiresAt: "2026-09-06T08:00:00.000Z" });
    expect(resolveAssignmentGrantState(assignment, new Date("2026-09-06T12:00:00.000Z"))).toBe(
      "expired",
    );
  });

  it("reports 'expired' at the exact expiry instant (boundary is inclusive)", () => {
    const assignment = assignmentFixture({ expiresAt: "2026-09-06T12:00:00.000Z" });
    expect(resolveAssignmentGrantState(assignment, new Date("2026-09-06T12:00:00.000Z"))).toBe(
      "expired",
    );
  });
});

describe("buildAgentCheckpoint", () => {
  it("short-circuits to 'unauthorized' and never calls the policy when read is denied", () => {
    let policyCalled = false;
    const sources = sourcesFixture({
      readAuthorization: {
        authorized: false,
        reason: "caller is not Lead or self for this target",
      },
    });

    const result = buildAgentCheckpoint(
      sources,
      stubPolicy(() => (policyCalled = true)),
    );

    expect(policyCalled).toBe(false);
    expect(result).toEqual({
      agentId: "agent-1",
      disposition: "unauthorized",
      waitingOn: [],
      evidence: [],
      allowedNextSteps: [],
      unknowns: ["read_not_authorized: caller is not Lead or self for this target"],
    });
  });

  it("never leaks evidence pointers when unauthorized, even if sources carry them", () => {
    const sources = sourcesFixture({
      readAuthorization: { authorized: false, reason: "no grant" },
      council: {
        caseId: "case-1",
        phase: "verdict",
        parentAgentId: "lead-1",
        seats: [],
      },
      beads: {
        accessible: true,
        issue: {
          issueId: "iss-1",
          status: "open",
          assigneeAgentId: null,
          openDependencyCount: 0,
          boundTargetAgentId: null,
          dependencyDataComplete: true,
        },
      },
    });

    const result = buildAgentCheckpoint(sources, stubPolicy());

    expect(result.evidence).toEqual([]);
    expect(result.waitingOn).toEqual([]);
  });

  it("delegates to the policy unchanged when read is authorized", () => {
    const sources = sourcesFixture();
    const result = buildAgentCheckpoint(sources, stubPolicy());
    expect(result).toEqual(STUB_RESULT);
  });

  it("does not mutate the sources object passed to the policy", () => {
    const sources = sourcesFixture({
      coordinationSignals: [],
    });
    const before = JSON.parse(JSON.stringify({ ...sources, now: sources.now.toISOString() }));

    buildAgentCheckpoint(sources, stubPolicy());

    const after = JSON.parse(JSON.stringify({ ...sources, now: sources.now.toISOString() }));
    expect(after).toEqual(before);
  });

  it("is deterministic: identical sources produce identical results across repeated calls", () => {
    const sources = sourcesFixture();
    const first = buildAgentCheckpoint(sources, stubPolicy());
    const second = buildAgentCheckpoint(sources, stubPolicy());
    expect(first).toEqual(second);
  });
});
