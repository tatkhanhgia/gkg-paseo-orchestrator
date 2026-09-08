import type {
  PaseoRoleId,
  RoleProfileBindingReceipt,
  WorkspaceProtocolBindingReceipt,
} from "@getpaseo/protocol/role-binding";
import type {
  HarnessBindingContext,
  HarnessBindingReceipt,
} from "@getpaseo/protocol/harness-binding";

import {
  buildSlpAssignmentInstruction,
  preflightSlpAssignmentEnvelope,
} from "./assignment-policy.js";
import {
  foundationExecutionProfileDefinitionDigest,
  getFoundationExecutionProfileDefinition,
  SLP_EXECUTION_PROFILE_POLICY,
} from "./execution-profiles.js";
import {
  buildHarnessPackageArtifactDescriptor,
  loadHarnessPackageDescriptor,
  projectRoleHarnessResources,
} from "./harness-package-policy.js";
import { getFoundationRoleDefinition } from "./role-definitions.js";
import { materializeRoleProfileBindingReceipt } from "./role-profiles.js";
import { loadFoundationSkillPolicy } from "./skill-policy.js";
import type {
  RoleBindingInstructionCompositionInput,
  RoleBindingPolicyContribution,
} from "../../role-binding-policy.js";

function workspaceProtocolReadership(
  roleId: PaseoRoleId,
): WorkspaceProtocolBindingReceipt["readership"] {
  return getFoundationRoleDefinition(roleId).protocolReadership;
}

function buildProtocolInstruction(
  receipt: WorkspaceProtocolBindingReceipt,
  hasProtocolException: boolean,
): string {
  if (receipt.status === "missing") {
    if (!hasProtocolException) {
      return `Workspace Protocol binding: not yet bootstrapped at ${receipt.path}. This assignment was admitted because it declares no write scope and no external effects. Treat the repository's coordination tactics as unknown rather than absent, stay non-mutating, and report that the protocol still needs bootstrapping at handback. Any write scope or external effect requires a bound protocol or an exact Human exception first.`;
    }
    if (receipt.readership === "assignment-only") {
      return `Workspace Protocol binding: temporarily missing under an exact Human bootstrap exception at ${receipt.path}. Do not load that path; remain inside the read-only/bootstrap assignment and stop at its expiry.`;
    }
    if (receipt.readership === "governance-only") {
      return `Workspace Protocol binding: temporarily missing under an exact Human governance exception at ${receipt.path}. Create, audit, or update it only inside that bounded mandate and stop at its expiry.`;
    }
    return `Workspace Protocol binding: temporarily missing under an exact Human bootstrap exception at ${receipt.path}. Bootstrap only the bounded governance artifact and stop at the assignment expiry.`;
  }
  if (receipt.readership === "assignment-only") {
    return `Workspace Protocol binding: assignment-only. Do not load ${receipt.path}; receive only relevant constraints in the Lead assignment.`;
  }
  if (receipt.readership === "governance-only") {
    return `Workspace Protocol binding: governance-only at ${receipt.path}. Read it only when the exact Human mandate requires protocol create/audit/update. Bound status: ${receipt.status}${receipt.digest ? `; sha256=${receipt.digest}` : ""}.`;
  }
  return `Workspace Protocol binding: full-read required at ${receipt.path}; sha256=${receipt.digest}. Read the exact current file before orchestration. If current bytes no longer match this digest, stop and request a fresh binding instead of relying on stale protocol state.`;
}

function buildBeadsSkillAdmissionInstruction(
  roleId: PaseoRoleId,
  roleProfile: RoleProfileBindingReceipt,
): string {
  const policy = loadFoundationSkillPolicy(roleId);
  const skillPath = policy.skillPaths.get("beads-issue-tracker");
  if (
    policy.status !== "bound" ||
    !policy.enabledNames.has("beads-issue-tracker") ||
    !roleProfile.allowedSkills.includes("beads-issue-tracker") ||
    !skillPath
  ) {
    throw new Error(
      "foundation_skill_admission_required: beads-issue-tracker is not bound for this role",
    );
  }
  return "Role skill admission: `beads-issue-tracker` is active from the immutable Foundation bundle. Its assignment-start checkpoint, mutation boundary, and handback rule are projected in the Assignment Contract above; do not search for or load a second copy.";
}

/**
 * Mandatory Project Harness admission for EVERY SLP role, including Peer.
 * Unlike `buildBeadsSkillAdmissionInstruction`, this is never gated on
 * `roleProfile.allowedSkills` or any `roleProfilePreferences` opt-out — a
 * role cannot deselect its own harness minimum. This function only reads the
 * immutable imported bundle (`loadHarnessPackageDescriptor`) and states the
 * role's already-validated minimum resource path(s); it performs no file
 * writes and never invents bootstrap state (H2's inspect/preview/apply RPC
 * owns actually materializing `docs/harness/*` into a project).
 */
function buildHarnessAdmissionInstruction(
  roleId: PaseoRoleId,
  harnessBinding: HarnessBindingReceipt,
): string {
  const entryMap = harnessBinding.resources.find((resource) => resource.key === "entryMap");
  if (!entryMap) {
    throw new Error(`harness_binding_missing_role_minimum: ${roleId}: entryMap`);
  }
  const resourcePins = harnessBinding.resources
    .map((resource) => `${resource.key}=${resource.path}#${resource.digest}`)
    .join(", ");
  return `Mandatory Project Harness admission (package ${harnessBinding.package}, generation ${harnessBinding.generation}, artifact ${harnessBinding.artifactDigest}; project=${harnessBinding.projectId}, workspace=${harnessBinding.workspaceId}): read ${entryMap.path} before orchestration. Pinned resources: ${resourcePins}. This is a mandatory role minimum, not an optional skill — it cannot be declined via role-profile preferences.`;
}

function composeInstructions(input: RoleBindingInstructionCompositionInput): string {
  const harnessInstruction = input.harnessBinding
    ? buildHarnessAdmissionInstruction(input.definition.id, input.harnessBinding)
    : undefined;
  return [
    input.definition.instructions,
    input.executionProfile?.instructions,
    buildProtocolInstruction(input.workspaceProtocol, input.hasProtocolException),
    buildSlpAssignmentInstruction(input.assignmentContract),
    harnessInstruction,
    buildBeadsSkillAdmissionInstruction(input.definition.id, input.roleProfile),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export const SLP_ROLE_BINDING_POLICY: RoleBindingPolicyContribution<string> = {
  getRoleDefinition: getFoundationRoleDefinition,
  getExecutionProfile: (profileId) =>
    getFoundationExecutionProfileDefinition(SLP_EXECUTION_PROFILE_POLICY.parseId(profileId)),
  executionProfileDefinitionDigest: (profile) =>
    foundationExecutionProfileDefinitionDigest(
      getFoundationExecutionProfileDefinition(SLP_EXECUTION_PROFILE_POLICY.parseId(profile.id)),
    ),
  materializeRoleProfile: (roleId, preferences, assignmentEffectClass) =>
    materializeRoleProfileBindingReceipt(roleId, preferences, assignmentEffectClass),
  workspaceProtocolReadership,
  materializeHarnessBinding(input: {
    roleId: PaseoRoleId;
    context: HarnessBindingContext;
  }): HarnessBindingReceipt {
    const descriptor = loadHarnessPackageDescriptor();
    const projection = projectRoleHarnessResources(descriptor, input.roleId);
    return {
      schemaVersion: 1,
      package: descriptor.package,
      generation: descriptor.generation,
      artifactDigest: descriptor.artifactDigest,
      descriptorPath: descriptor.descriptorPath,
      descriptorDigest: descriptor.descriptorDigest,
      resources: projection.resourceKeys.map((key) => ({
        key,
        path: descriptor.resourcePaths[key],
        digest: descriptor.resourceDigests[key],
      })),
      projectId: input.context.projectId,
      workspaceId: input.context.workspaceId,
      workspaceRoot: input.context.workspaceRoot,
      projectRoot: input.context.projectRoot,
      cwd: input.context.cwd,
      ...(input.context.notebook ? { notebook: input.context.notebook } : {}),
    };
  },
  assertHarnessBindingCurrent(binding: HarnessBindingReceipt): void {
    const descriptor = loadHarnessPackageDescriptor(binding.descriptorPath);
    const current = buildHarnessPackageArtifactDescriptor(descriptor);
    if (
      descriptor.package !== binding.package ||
      descriptor.generation !== binding.generation ||
      descriptor.descriptorPath !== binding.descriptorPath ||
      current.artifactDigest !== binding.artifactDigest ||
      current.descriptorDigest !== binding.descriptorDigest
    ) {
      throw new Error(
        `harness_binding_stale: pinned=${binding.package}@${binding.generation}/${binding.artifactDigest}; current=${descriptor.package}@${descriptor.generation}/${current.artifactDigest}`,
      );
    }
    for (const resource of binding.resources) {
      const currentResource = current.resources.find((candidate) => candidate.key === resource.key);
      const currentPath = currentResource?.path;
      if (
        !currentResource ||
        currentPath !==
          descriptor.resourceRelativePaths[
            resource.key as keyof typeof descriptor.resourceRelativePaths
          ] ||
        descriptor.resourcePaths[resource.key as keyof typeof descriptor.resourcePaths] !==
          resource.path ||
        currentResource.digest !== resource.digest
      ) {
        throw new Error(`harness_binding_stale: resource ${resource.key}`);
      }
    }
  },
  composeInstructions,
  preflight(input) {
    const envelope = preflightSlpAssignmentEnvelope({
      roleId: input.roleId,
      envelope: input.assignment,
      createdAt: input.createdAt,
    });
    if (input.executionProfileId) {
      const executionProfile = getFoundationExecutionProfileDefinition(
        SLP_EXECUTION_PROFILE_POLICY.parseId(input.executionProfileId),
      );
      if (executionProfile.authorityRoleId !== input.roleId) {
        throw new Error(
          `Execution profile '${executionProfile.id}' requires role '${executionProfile.authorityRoleId}'`,
        );
      }
    }
    return envelope;
  },
};
