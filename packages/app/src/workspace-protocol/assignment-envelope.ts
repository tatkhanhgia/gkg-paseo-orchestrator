import {
  assignmentExternalEffectBoundaryFor,
  PASEO_ASSIGNMENT_CONTRACT_VERSION,
  type AssignmentEffectClass,
  type AssignmentEnvelope,
} from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

function dispositionForRole(roleId: PaseoRoleId): AssignmentEnvelope["disposition"] {
  if (roleId === "lead") return "lead-direct";
  if (roleId === "peer") return "peer-execution";
  return "supervision";
}

function mutationBoundaryForEffect(
  effectClass: AssignmentEffectClass,
  cwd: string,
): AssignmentEnvelope["mutationBoundary"] {
  if (effectClass === "mutating") return { mode: "bounded-write", scope: cwd };
  if (effectClass === "bootstrap") {
    const separator = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
    return {
      mode: "bounded-write",
      scope: `${cwd.replace(/[\\/]+$/u, "")}${separator}WORKSPACE_PROTOCOL.md`,
    };
  }
  return { mode: "no-write" };
}

export function buildAssignmentEnvelope(input: {
  roleId: PaseoRoleId;
  effectClass: AssignmentEffectClass;
  objective: string;
  cwd: string;
  beadsIssueIds?: readonly string[];
  externalEffects?: readonly string[];
}): AssignmentEnvelope {
  const objective = input.objective.trim();
  if (!objective) {
    throw new Error("assignment_contract_required: objective");
  }
  const beadsIssueIds = Array.from(
    new Set((input.beadsIssueIds ?? []).map((issueId) => issueId.trim()).filter(Boolean)),
  );
  const externalEffects = Array.from(
    new Set((input.externalEffects ?? []).map((grant) => grant.trim()).filter(Boolean)),
  );
  if (input.roleId === "peer" && input.effectClass === "mutating" && beadsIssueIds.length === 0) {
    throw new Error("assignment_contract_required: mutating Peer Beads issue grant");
  }
  const externalEffectBoundary = assignmentExternalEffectBoundaryFor(
    input.roleId,
    input.effectClass,
    externalEffects,
  );
  if (externalEffects.length > 0 && externalEffectBoundary.mode === "denied") {
    throw new Error("assignment_contract_required: external access requires a bounded boundary");
  }
  const hasResourceGrants = beadsIssueIds.length > 0 || externalEffects.length > 0;
  return {
    version: PASEO_ASSIGNMENT_CONTRACT_VERSION,
    disposition: dispositionForRole(input.roleId),
    objective,
    effectClass: input.effectClass,
    mutationBoundary: mutationBoundaryForEffect(input.effectClass, input.cwd),
    externalEffectBoundary,
    ...(hasResourceGrants
      ? {
          resourceGrants: {
            ...(beadsIssueIds.length > 0 ? { beadsIssueIds } : {}),
            ...(externalEffects.length > 0 ? { externalEffects } : {}),
          },
        }
      : {}),
    evidence: "Return exact changed or inspected scope and proportional verification.",
    handbackAndStop:
      "Stop at completion or a material blocker; hand back evidence, unknowns, residual risk, and lease state.",
  };
}
