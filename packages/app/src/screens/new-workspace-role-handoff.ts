import type { AssignmentEffectClass } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

export interface NewWorkspaceRoleHandoff {
  roleId: PaseoRoleId;
  assignmentEffect: AssignmentEffectClass;
  beadsIssueIds: string[];
  externalEffects: string[];
}

export function buildNewWorkspaceRoleHandoff(input: {
  roleId: PaseoRoleId | null;
  assignmentEffect: AssignmentEffectClass;
  beadsIssueIds: readonly string[];
  externalEffects: readonly string[];
}): NewWorkspaceRoleHandoff | Record<string, never> {
  if (!input.roleId) return {};
  return {
    roleId: input.roleId,
    assignmentEffect: input.assignmentEffect,
    beadsIssueIds: [...input.beadsIssueIds],
    externalEffects: [...input.externalEffects],
  };
}
