import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import { materializeTrustedRoleBinding } from "../../trusted-policy.js";
import { buildWorkspaceProtocolTemplate } from "../../../../utils/workspace-protocol-file.js";
import { NON_SLP_FIXTURE_POLICY_CONTRIBUTION } from "../../non-slp-fixture-policy.js";
import { createDefaultSlpBundledPolicyRegistry } from "../../bundled/slp.js";
import { loadHarnessPackageDescriptor } from "./harness-package-policy.js";
import { createProjectHarnessBindingService } from "../../../project/harness-binding-service.js";

/**
 * H1: mandatory, non-deselectable Project Harness admission for EVERY SLP
 * role (including Peer), through the real `materializeTrustedRoleBinding`
 * production entrypoint — and proves it is neutral (absent) for a non-SLP
 * policy contribution, since only `SLP_ROLE_BINDING_POLICY.composeInstructions`
 * calls `buildHarnessAdmissionInstruction`.
 */

const CWD = mkdtempSync(join(tmpdir(), "harness-admission-binding-"));
writeFileSync(join(CWD, "WORKSPACE_PROTOCOL.md"), buildWorkspaceProtocolTemplate(CWD), "utf8");
afterAll(() => rmSync(CWD, { recursive: true, force: true }));

function envelopeFor(roleId: PaseoRoleId): AssignmentEnvelope {
  if (roleId === "lead") {
    return {
      version: 1,
      disposition: "lead-direct",
      objective: "Directly perform a tiny, bounded engineering task.",
      effectClass: "mutating",
      mutationBoundary: { mode: "bounded-write", scope: "Exact tiny task files only." },
      externalEffectBoundary: { mode: "denied" },
      resourceGrants: { beadsIssueIds: ["fixture-issue-1"] },
      evidence: "Return the exact diff.",
      handbackAndStop: "Stop at the bounded task's completion.",
    };
  }
  if (roleId === "peer") {
    return {
      version: 1,
      disposition: "peer-execution",
      objective: "Implement a bounded slice independently.",
      effectClass: "mutating",
      mutationBoundary: { mode: "bounded-write", scope: "Exact assigned files only." },
      externalEffectBoundary: { mode: "denied" },
      resourceGrants: { beadsIssueIds: ["fixture-issue-1"] },
      evidence: "Return the exact diff.",
      handbackAndStop: "Stop at handback.",
    };
  }
  return {
    version: 1,
    disposition: "supervision",
    objective: "Coordinate Peer work.",
    effectClass: "delegation",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Return exact coordination evidence.",
    handbackAndStop: "Stop at the bounded coordination handback.",
  };
}

async function materialize(roleId: PaseoRoleId, agentId: string) {
  const registry = createDefaultSlpBundledPolicyRegistry();
  const generation = registry.resolveActive("slp");
  const resolveHarnessBinding = createProjectHarnessBindingService({
    workspaceRegistry: {
      get: async (workspaceId) =>
        ({ workspaceId, projectId: "project-1", cwd: CWD, archivedAt: null }) as never,
    },
    projectRegistry: {
      get: async (projectId) => ({ projectId, rootPath: CWD, archivedAt: null }) as never,
      list: async () => [{ projectId: "project-1", rootPath: CWD, archivedAt: null }] as never,
    },
  });
  return materializeTrustedRoleBinding(generation, {
    roleId,
    provider: "codex",
    providerSupport: { status: "supported", injectionMethod: "mock-launch-context" },
    cwd: CWD,
    workspaceId: "workspace-1",
    assignment: envelopeFor(roleId),
    assignmentAssigner: { kind: "human-session" },
    agentId,
    resolveHarnessBinding,
  });
}

describe("mandatory Project Harness admission (H1)", () => {
  test.each(["lead", "peer", "supervisor"] as const)(
    "every SLP role (%s) is admitted with the mandatory harness instruction citing the real imported entry map path",
    async (roleId) => {
      const descriptor = loadHarnessPackageDescriptor();
      const binding = await materialize(roleId, `${roleId}-harness-admission-1`);
      expect(binding.instructions).toContain("Mandatory Project Harness admission");
      expect(binding.instructions).toContain(descriptor.resourcePaths.entryMap);
      expect(binding.instructions).toContain("cannot be declined via role-profile preferences");
    },
  );

  test("harness admission has no roleProfilePreferences knob to opt out of — it is present even when preferences narrow everything else to its own mandatory minimum", async () => {
    const registry = createDefaultSlpBundledPolicyRegistry();
    const generation = registry.resolveActive("slp");
    const resolveHarnessBinding = createProjectHarnessBindingService({
      workspaceRegistry: {
        get: async (workspaceId) =>
          ({ workspaceId, projectId: "project-1", cwd: CWD, archivedAt: null }) as never,
      },
      projectRegistry: {
        get: async (projectId) => ({ projectId, rootPath: CWD, archivedAt: null }) as never,
        list: async () => [{ projectId: "project-1", rootPath: CWD, archivedAt: null }] as never,
      },
    });
    const binding = await materializeTrustedRoleBinding(generation, {
      roleId: "peer",
      provider: "codex",
      providerSupport: { status: "supported", injectionMethod: "mock-launch-context" },
      cwd: CWD,
      workspaceId: "workspace-1",
      assignment: envelopeFor("peer"),
      assignmentAssigner: { kind: "human-session" },
      agentId: "peer-harness-admission-no-optout",
      resolveHarnessBinding,
      roleProfilePreferences: { allowedSkills: ["beads-issue-tracker"] },
    });
    expect(binding.instructions).toContain("Mandatory Project Harness admission");
  });

  test("a non-SLP policy contribution's composed instructions never mention harness admission", () => {
    const fixtureInstructions =
      NON_SLP_FIXTURE_POLICY_CONTRIBUTION.roleBindingPolicy.composeInstructions({
        definition: { id: "peer", version: "fixture", instructions: "Fixture role instructions." },
        executionProfile: null,
        workspaceProtocol: {
          status: "bound",
          readership: "assignment-only",
          path: "WORKSPACE_PROTOCOL.md",
        },
        hasProtocolException: false,
        assignmentContract: {
          envelope: envelopeFor("peer"),
          receipt: { contractVersion: 1, createdAt: new Date().toISOString() },
        } as never,
        roleProfile: { allowedTools: [], allowedSkills: [] } as never,
      });
    expect(fixtureInstructions).not.toContain("Mandatory Project Harness admission");
  });
});
