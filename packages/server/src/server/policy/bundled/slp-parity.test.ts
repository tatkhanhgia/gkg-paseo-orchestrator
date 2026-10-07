import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import { buildWorkspaceProtocolTemplate } from "../../../utils/workspace-protocol-file.js";
import type { FoundationExecutionProfileId } from "./slp/execution-profiles.js";
import { materializeRoleBinding as materializeLegacyRoleBinding } from "../../agent/legacy-role-binding.js";
import { createDefaultSlpBundledPolicyRegistry } from "./slp.js";
import { createProjectHarnessBindingService } from "../../project/harness-binding-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Sections the bundled SLP policy adds on purpose after the legacy core was frozen. Parity
// is asserted on every other byte; these two are named so any further addition fails.
const DELIBERATE_BUNDLED_SECTION_PREFIXES = [
  "Mandatory Project Harness admission (",
  "Test proof mandate: ",
] as const;

function withoutDeliberateBundledSections(instructions: string): string {
  return instructions
    .split("\n\n")
    .filter(
      (paragraph) =>
        !DELIBERATE_BUNDLED_SECTION_PREFIXES.some((prefix) => paragraph.startsWith(prefix)),
    )
    .join("\n\n");
}

function assignmentFor(roleId: PaseoRoleId): AssignmentEnvelope {
  let disposition: AssignmentEnvelope["disposition"] = "supervision";
  if (roleId === "lead") disposition = "lead-direct";
  if (roleId === "peer") disposition = "peer-execution";
  return {
    version: 1,
    disposition,
    objective: "Prove exact bundled SLP migration parity.",
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Compare exact materialized bytes and immutable receipts.",
    handbackAndStop: "Stop after the parity receipt.",
  };
}

describe("bundled SLP role-binding parity", () => {
  test.each([
    { roleId: "lead", provider: "codex" },
    { roleId: "peer", provider: "claude" },
    { roleId: "supervisor", provider: "pi" },
    { roleId: "peer", provider: "omp", executionProfileId: "review" },
    { roleId: "peer", provider: "codex", executionProfileId: "solution-architect" },
    { roleId: "peer", provider: "claude", executionProfileId: "reviewer" },
  ] as const)(
    "preserves $roleId/$executionProfileId legacy bytes on $provider except the deliberate harness and test-proof sections",
    async ({ roleId, provider, executionProfileId }) => {
      const cwd = await mkdtemp(join(tmpdir(), "paseo-slp-parity-"));
      temporaryDirectories.push(cwd);
      await writeFile(
        join(cwd, "WORKSPACE_PROTOCOL.md"),
        buildWorkspaceProtocolTemplate(cwd),
        "utf8",
      );
      const input = {
        roleId,
        provider,
        cwd,
        workspaceId: `workspace:${cwd}`,
        assignment: assignmentFor(roleId),
        assignmentAssigner: { kind: "human-session" as const },
        createdAt: new Date("2026-08-27T00:00:00.000Z"),
        ...(executionProfileId
          ? { executionProfileId: executionProfileId as FoundationExecutionProfileId }
          : {}),
      };

      const legacy = await materializeLegacyRoleBinding(input);
      const generation = createDefaultSlpBundledPolicyRegistry().resolveActive("slp");
      const resolveHarnessBinding = createProjectHarnessBindingService({
        workspaceRegistry: {
          get: async (workspaceId) =>
            ({ workspaceId, projectId: "project-1", cwd, archivedAt: null }) as never,
        },
        projectRegistry: {
          get: async (projectId) => ({ projectId, rootPath: cwd, archivedAt: null }) as never,
          list: async () => [{ projectId: "project-1", rootPath: cwd, archivedAt: null }] as never,
        },
      });
      const plugin = await generation.contribution.materializeRoleBinding(
        { ...input, agentId: "agent-parity", resolveHarnessBinding },
        generation.owner,
      );
      const {
        policyOwner: legacyOwner,
        bindingDigest: _legacyDigest,
        instructions: legacyInstructions,
        ...legacyBytes
      } = legacy;
      const {
        policyOwner: pluginOwner,
        bindingDigest: pluginDigest,
        instructions: pluginInstructions,
        harnessBinding: pluginHarnessBinding,
        ...pluginBytes
      } = plugin;

      expect(legacyOwner).toEqual({ kind: "legacy-core" });
      expect(pluginOwner).toEqual(generation.owner);
      expect(pluginBytes).toEqual(legacyBytes);
      expect(pluginHarnessBinding?.package).toBe("paseo-project-harness");
      expect(Buffer.from(withoutDeliberateBundledSections(pluginInstructions))).toEqual(
        Buffer.from(legacyInstructions),
      );
      expect(pluginDigest).toBe(createHash("sha256").update(pluginInstructions).digest("hex"));
      if (roleId === "peer") {
        expect(plugin.roleProfile?.allowedTools).not.toEqual(
          expect.arrayContaining([
            "beads_create",
            "beads_claim",
            "beads_update",
            "beads_add_dependency",
            "beads_close",
          ]),
        );
      }
    },
  );
});
