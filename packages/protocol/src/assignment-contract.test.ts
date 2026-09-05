import { describe, expect, test } from "vitest";

import {
  AssignmentContractReceiptSchema,
  AssignmentEnvelopeSchema,
  AssignmentResourceGrantsSchema,
  assignmentExternalEffectBoundaryFor,
  assignmentExternalEffectBoundaryForEnvelope,
  isAssignmentEffectAllowedForRole,
  PASEO_BEADS_EXTERNAL_EFFECT_SCOPE,
} from "./assignment-contract.js";

const BASE_ENVELOPE = {
  version: 1 as const,
  disposition: "peer-execution" as const,
  objective: "test objective",
  effectClass: "mutating" as const,
  mutationBoundary: { mode: "no-write" as const },
  externalEffectBoundary: { mode: "denied" as const },
  evidence: "test evidence",
  handbackAndStop: "test handback",
};

const BASE_RECEIPT = {
  version: 1 as const,
  assignmentDigest: "a".repeat(64),
  roleId: "peer" as const,
  disposition: "peer-execution" as const,
  assigner: { kind: "human-session" as const },
  workspaceId: "workspace-1",
  cwd: "/repo",
  effectClass: "mutating" as const,
  mutationBoundary: { mode: "no-write" as const },
  externalEffectBoundary: { mode: "denied" as const },
  createdAt: "2026-09-07T00:00:00.000Z",
};

describe("assignment external-effect defaults", () => {
  test("leases only the mandatory Beads graph to mutating Lead and Peer work", () => {
    expect(assignmentExternalEffectBoundaryFor("lead", "delegation")).toEqual({
      mode: "bounded",
      scope: PASEO_BEADS_EXTERNAL_EFFECT_SCOPE,
    });
    expect(assignmentExternalEffectBoundaryFor("lead", "mutating")).toEqual({
      mode: "bounded",
      scope: PASEO_BEADS_EXTERNAL_EFFECT_SCOPE,
    });
    expect(assignmentExternalEffectBoundaryFor("peer", "mutating")).toEqual({
      mode: "bounded",
      scope: PASEO_BEADS_EXTERNAL_EFFECT_SCOPE,
    });
  });

  test("keeps read-only and Supervisor assignments externally denied", () => {
    expect(assignmentExternalEffectBoundaryFor("lead", "read-only")).toEqual({ mode: "denied" });
    expect(assignmentExternalEffectBoundaryFor("peer", "read-only")).toEqual({ mode: "denied" });
    expect(assignmentExternalEffectBoundaryFor("supervisor", "recovery")).toEqual({
      mode: "denied",
    });
    expect(assignmentExternalEffectBoundaryFor("supervisor", "delegation")).toEqual({
      mode: "denied",
    });
    expect(isAssignmentEffectAllowedForRole("supervisor", "delegation")).toBe(true);
  });
});

describe("notebookGrant compatibility shape", () => {
  test("an envelope with no notebookGrant still parses (old-client-shaped payload)", () => {
    expect(AssignmentEnvelopeSchema.parse(BASE_ENVELOPE).notebookGrant).toBeUndefined();
  });

  test("an envelope requesting a notebookGrant parses with only scope/expiresAt, as a top-level field", () => {
    const parsed = AssignmentEnvelopeSchema.parse({
      ...BASE_ENVELOPE,
      notebookGrant: { scope: "coordination notes", expiresAt: "2026-12-31T00:00:00.000Z" },
    });
    expect(parsed.notebookGrant).toEqual({
      scope: "coordination notes",
      expiresAt: "2026-12-31T00:00:00.000Z",
    });
  });

  test("a receipt with no notebookGrant still parses (old-client-shaped payload)", () => {
    expect(AssignmentContractReceiptSchema.parse(BASE_RECEIPT).notebookGrant).toBeUndefined();
  });

  test("a receipt's notebookGrant carries daemon-resolved identity fields, not just the caller's request shape", () => {
    const parsed = AssignmentContractReceiptSchema.parse({
      ...BASE_RECEIPT,
      notebookGrant: {
        effect: "notebook-write",
        notebookId: "nb_abc123",
        location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
        projectId: "prj_abc123",
        scope: "coordination notes",
        designatedWriterId: "agent-1",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    });
    expect(parsed.notebookGrant?.effect).toBe("notebook-write");
    expect(parsed.notebookGrant?.designatedWriterId).toBe("agent-1");
  });

  test("notebookGrant is never accepted inside the strict resourceGrants object", () => {
    expect(() =>
      AssignmentResourceGrantsSchema.parse({
        notebookGrant: { scope: "x", expiresAt: "2026-12-31T00:00:00.000Z" },
      }),
    ).toThrow();
  });

  test("an unrecognized extra top-level field on the envelope does not break parsing (additive-forward-compat proxy)", () => {
    const parsed = AssignmentEnvelopeSchema.parse({
      ...BASE_ENVELOPE,
      someFutureField: "daemon added this later",
    });
    expect(parsed.objective).toBe("test objective");
  });

  test("derives the bounded scope from trimmed external access grants", () => {
    const externalEffects = ["  read dev database  ", "write sandbox API"];
    expect(assignmentExternalEffectBoundaryFor("peer", "mutating", externalEffects)).toEqual({
      mode: "bounded",
      scope:
        "Beads Central issue/work graph for this assignment only; plus Human-leased external access: read dev database; write sandbox API",
    });

    const envelope = AssignmentEnvelopeSchema.parse({
      version: 1,
      disposition: "peer-execution",
      objective: "Implement the bounded assignment.",
      effectClass: "mutating",
      mutationBoundary: { mode: "bounded-write", scope: "/repo" },
      externalEffectBoundary: assignmentExternalEffectBoundaryFor(
        "peer",
        "mutating",
        externalEffects,
      ),
      resourceGrants: { beadsIssueIds: ["ps123-abc"], externalEffects },
      evidence: "Return focused verification.",
      handbackAndStop: "Stop after handback.",
    });

    expect(envelope.resourceGrants?.externalEffects).toEqual([
      "read dev database",
      "write sandbox API",
    ]);
    expect(assignmentExternalEffectBoundaryForEnvelope("peer", envelope)).toEqual(
      envelope.externalEffectBoundary,
    );
  });
});
