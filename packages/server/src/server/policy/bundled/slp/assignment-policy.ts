import {
  assignmentExternalEffectBoundaryFor,
  isAssignmentEffectAllowedForRole,
  type AssignmentEnvelope,
} from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

import {
  ASSIGNMENT_CONTRACT_INVALID_ERROR,
  preflightAssignmentEnvelope,
  type PersistedAssignmentContract,
} from "../../../agent/assignment-contract.js";

function validateRoleDisposition(roleId: PaseoRoleId, envelope: AssignmentEnvelope): void {
  const allowed: Record<PaseoRoleId, readonly AssignmentEnvelope["disposition"][]> = {
    lead: ["lead-direct"],
    peer: ["peer-execution", "independent-review"],
    supervisor: ["supervision"],
  };
  if (!allowed[roleId].includes(envelope.disposition)) {
    throw new Error(
      `${ASSIGNMENT_CONTRACT_INVALID_ERROR}: disposition '${envelope.disposition}' does not match role '${roleId}'`,
    );
  }
  if (!isAssignmentEffectAllowedForRole(roleId, envelope.effectClass)) {
    throw new Error(
      `${ASSIGNMENT_CONTRACT_INVALID_ERROR}: effect '${envelope.effectClass}' is not allowed for role '${roleId}'`,
    );
  }
}

function validateEffectBoundaries(envelope: AssignmentEnvelope): void {
  const noWriteEffects = new Set<AssignmentEnvelope["effectClass"]>(["read-only", "delegation"]);
  if (noWriteEffects.has(envelope.effectClass) && envelope.mutationBoundary.mode !== "no-write") {
    throw new Error(
      `${ASSIGNMENT_CONTRACT_INVALID_ERROR}: ${envelope.effectClass} requires no-write`,
    );
  }
  if (envelope.effectClass === "mutating" && envelope.mutationBoundary.mode !== "bounded-write") {
    throw new Error(`${ASSIGNMENT_CONTRACT_INVALID_ERROR}: mutating requires bounded-write`);
  }
}

function validateExternalEffectBoundary(roleId: PaseoRoleId, envelope: AssignmentEnvelope): void {
  const requiredMode = assignmentExternalEffectBoundaryFor(roleId, envelope.effectClass).mode;
  if (requiredMode === "denied" && envelope.externalEffectBoundary.mode !== "denied") {
    throw new Error(
      `${ASSIGNMENT_CONTRACT_INVALID_ERROR}: ${roleId} ${envelope.effectClass} requires external effects ${requiredMode}`,
    );
  }
}

function validateResourceGrants(roleId: PaseoRoleId, envelope: AssignmentEnvelope): void {
  if (
    roleId === "peer" &&
    envelope.effectClass === "mutating" &&
    !envelope.resourceGrants?.beadsIssueIds?.length
  ) {
    throw new Error(
      `${ASSIGNMENT_CONTRACT_INVALID_ERROR}: mutating Peer requires an exact Beads issue grant`,
    );
  }
}

export function preflightSlpAssignmentEnvelope(input: {
  roleId: PaseoRoleId;
  envelope: AssignmentEnvelope | undefined;
  createdAt?: Date;
}): AssignmentEnvelope {
  const envelope = preflightAssignmentEnvelope(input);
  validateRoleDisposition(input.roleId, envelope);
  validateEffectBoundaries(envelope);
  validateExternalEffectBoundary(input.roleId, envelope);
  validateResourceGrants(input.roleId, envelope);
  if (
    envelope.protocolException &&
    !new Set(["read-only", "bootstrap", "recovery"]).has(envelope.effectClass)
  ) {
    throw new Error(
      `${ASSIGNMENT_CONTRACT_INVALID_ERROR}: protocol exception is not allowed for ${envelope.effectClass}`,
    );
  }
  return envelope;
}

function trackerCheckpointForRole(
  roleId: PaseoRoleId,
  effectClass: AssignmentEnvelope["effectClass"],
): string {
  const canMutateTracker =
    assignmentExternalEffectBoundaryFor(roleId, effectClass).mode === "bounded";
  const receiptRule = `Resolve the exact logical tool from the current provider tool catalog; never guess or hard-code an MCP namespace. Only an authoritative Paseo tool receipt counts as the checkpoint; a missing or failed selector leaves issue state UNKNOWN${canMutateTracker ? " and blocks tracker mutation" : " while source inspection continues inside the no-write lease"}.`;
  if (roleId === "lead") {
    return `Mandatory Beads Central checkpoint: call beads_status at assignment start. ${receiptRule} Inspect or create the durable issue before material routing/work; update authoritative evidence at handoff; close only after your engineering verdict. If Central is unavailable, report BLOCKED and do not use native bd or another tracker.`;
  }
  if (roleId === "peer") {
    const issueScope =
      effectClass === "mutating"
        ? "inspect the daemon-verified granted issue"
        : "inspect a relevant issue when one is available; no issue grant is required for read-only source inspection";
    return `Mandatory Beads Central checkpoint: call beads_status and ${issueScope} at assignment start. ${receiptRule} Claim before owned mutation, update evidence/blockers before handoff, and never close. If Central is unavailable, do not use native bd or another tracker${canMutateTracker ? "; report BLOCKED" : "; continue only the read-only source inspection and report issue state UNKNOWN"}.`;
  }
  return `Mandatory Beads Central checkpoint: call beads_status and read the relevant issue graph at supervision start and material handoff when Central is available. ${receiptRule} Remain read-only. If Central is unavailable, continue only the no-write inspection, report issue state UNKNOWN, and do not use native bd or another tracker.`;
}

export function buildSlpAssignmentInstruction(contract: PersistedAssignmentContract): string {
  const { envelope, receipt } = contract;
  const writeScope =
    envelope.mutationBoundary.mode === "bounded-write"
      ? `bounded-write (${envelope.mutationBoundary.scope})`
      : "no-write";
  const externalScope =
    envelope.externalEffectBoundary.mode === "bounded"
      ? `bounded (${envelope.externalEffectBoundary.scope})`
      : "denied";
  const beadsIssueGrants = envelope.resourceGrants?.beadsIssueIds?.join(", ") || "none";
  const trackerCheckpoint = trackerCheckpointForRole(receipt.roleId, envelope.effectClass);
  const technicalCapabilityBoundary =
    envelope.mutationBoundary.mode === "no-write"
      ? "Technical capability boundary: Paseo pins this session to a provider-enforced no-write mode. Do not request or attempt a mode change or permission escalation; launch must fail closed when the provider cannot enforce no-write."
      : "Technical capability boundary: runtime capability does not expand the exact bounded-write scope or external-effect lease above.";
  const supervisorDelegationBoundary =
    receipt.roleId === "supervisor" && envelope.effectClass === "delegation"
      ? "Human-issued topology lease: you may create and prompt only your own direct role-bound Lead children through Paseo. Those Leads own their project engineering and may delegate only to their own Peers; do not bypass a Lead to direct its Peers."
      : null;
  const notebookGrantLine = receipt.notebookGrant
    ? `Notebook grant: durable write access to project notebook ${receipt.notebookGrant.location} (notebookId=${receipt.notebookGrant.notebookId}, projectId=${receipt.notebookGrant.projectId}); scope: ${receipt.notebookGrant.scope}; expires ${receipt.notebookGrant.expiresAt}. This is a narrow explicit effect independent of the mutation/external-effect boundaries above.`
    : null;
  return [
    `Assignment Contract: sha256=${receipt.assignmentDigest}; disposition=${envelope.disposition}; effect=${envelope.effectClass}.`,
    `Objective: ${envelope.objective}`,
    `Mutation boundary: ${writeScope}. External effects: ${externalScope}.`,
    technicalCapabilityBoundary,
    supervisorDelegationBoundary,
    notebookGrantLine,
    `Beads issue grants: ${beadsIssueGrants}.`,
    trackerCheckpoint,
    `Evidence: ${envelope.evidence}`,
    `Handback/stop: ${envelope.handbackAndStop}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
