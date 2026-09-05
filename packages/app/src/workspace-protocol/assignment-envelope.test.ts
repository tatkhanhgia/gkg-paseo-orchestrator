import { describe, expect, test } from "vitest";
import { buildAssignmentEnvelope } from "./assignment-envelope";

describe("assignment envelope", () => {
  test("keeps read-only as no-write and bounds mutation to the exact workspace", () => {
    expect(
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "read-only",
        objective: "Inspect current state",
        cwd: "/repo",
      }).mutationBoundary,
    ).toEqual({ mode: "no-write" });
    expect(
      buildAssignmentEnvelope({
        roleId: "peer",
        effectClass: "mutating",
        objective: "Implement the bounded fix",
        cwd: "/repo/worktree",
        beadsIssueIds: ["ps123-abc"],
      }),
    ).toMatchObject({
      disposition: "peer-execution",
      mutationBoundary: { mode: "bounded-write", scope: "/repo/worktree" },
      externalEffectBoundary: {
        mode: "bounded",
        scope: "Beads Central issue/work graph for this assignment only; no other external effects",
      },
      resourceGrants: { beadsIssueIds: ["ps123-abc"] },
    });
  });

  test("allows read-only Peer without a grant and normalizes an optional exact grant", () => {
    expect(
      buildAssignmentEnvelope({
        roleId: "peer",
        effectClass: "read-only",
        objective: "Review source without graph mutation",
        cwd: "/repo",
      }).resourceGrants,
    ).toBeUndefined();

    expect(
      buildAssignmentEnvelope({
        roleId: "peer",
        effectClass: "read-only",
        objective: "Review the granted issue",
        cwd: "/repo",
        beadsIssueIds: [" ps123-abc ", "ps123-abc"],
      }).resourceGrants,
    ).toEqual({ beadsIssueIds: ["ps123-abc"] });

    expect(() =>
      buildAssignmentEnvelope({
        roleId: "peer",
        effectClass: "mutating",
        objective: "Implement the granted issue",
        cwd: "/repo",
      }),
    ).toThrow("assignment_contract_required: mutating Peer Beads issue grant");
  });

  test("keeps read-only and Supervisor launches externally denied", () => {
    expect(
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "read-only",
        objective: "Inspect current state",
        cwd: "/repo",
      }).externalEffectBoundary,
    ).toEqual({ mode: "denied" });
    expect(
      buildAssignmentEnvelope({
        roleId: "supervisor",
        effectClass: "recovery",
        objective: "Observe an exact recovery",
        cwd: "/repo",
      }).externalEffectBoundary,
    ).toEqual({ mode: "denied" });
  });

  test("normalizes external access grants and derives their bounded scope", () => {
    expect(
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "mutating",
        objective: "Update staging data",
        cwd: "/repo",
        externalEffects: [" staging API ", "", "dev database", "staging API"],
      }),
    ).toMatchObject({
      externalEffectBoundary: {
        mode: "bounded",
        scope:
          "Beads Central issue/work graph for this assignment only; plus Human-leased external access: staging API; dev database",
      },
      resourceGrants: { externalEffects: ["staging API", "dev database"] },
    });

    expect(() =>
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "read-only",
        objective: "Inspect only",
        cwd: "/repo",
        externalEffects: ["staging API"],
      }),
    ).toThrow("assignment_contract_required: external access requires a bounded boundary");
  });

  test("rejects a role launch without an objective", () => {
    expect(() =>
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "read-only",
        objective: "   ",
        cwd: "/repo",
      }),
    ).toThrow("assignment_contract_required: objective");
  });

  test("bounds bootstrap to the root protocol artifact", () => {
    expect(
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "bootstrap",
        objective: "Create the baseline protocol",
        cwd: "/repo",
      }).mutationBoundary,
    ).toEqual({ mode: "bounded-write", scope: "/repo/WORKSPACE_PROTOCOL.md" });
    expect(
      buildAssignmentEnvelope({
        roleId: "lead",
        effectClass: "bootstrap",
        objective: "Create the baseline protocol",
        cwd: "C:\\repo\\",
      }).mutationBoundary,
    ).toEqual({ mode: "bounded-write", scope: "C:\\repo\\WORKSPACE_PROTOCOL.md" });
  });
});
