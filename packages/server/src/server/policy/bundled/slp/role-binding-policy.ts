import type {
  PaseoRoleId,
  RoleProfileBindingReceipt,
  WorkspaceProtocolBindingReceipt,
} from "@getpaseo/protocol/role-binding";

import {
  buildSlpAssignmentInstruction,
  preflightSlpAssignmentEnvelope,
} from "./assignment-policy.js";
import {
  foundationExecutionProfileDefinitionDigest,
  getFoundationExecutionProfileDefinition,
  SLP_EXECUTION_PROFILE_POLICY,
} from "./execution-profiles.js";
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

function composeInstructions(input: RoleBindingInstructionCompositionInput): string {
  return [
    input.definition.instructions,
    input.executionProfile?.instructions,
    buildProtocolInstruction(input.workspaceProtocol, input.hasProtocolException),
    buildSlpAssignmentInstruction(input.assignmentContract),
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
