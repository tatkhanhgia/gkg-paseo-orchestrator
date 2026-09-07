import type {
  ProjectHarnessChange,
  ProjectHarnessFileRevision,
  ProjectHarnessInspection,
  ProjectHarnessRpcError,
} from "@getpaseo/protocol/messages";

export type ProjectHarnessCoverage = "complete" | "partial" | "unknown";

export interface ProjectHarnessInspectionSummary {
  relationship: ProjectHarnessInspection["relationship"]["kind"];
  provenancePackage: string;
  provenanceGeneration: number;
  provenanceArtifactDigest: string;
  metadataStatus: ProjectHarnessInspection["metadata"]["status"];
  foreignOwnershipStatus: ProjectHarnessInspection["foreignOwnership"]["status"];
  foreignLocalDeltaCount: number;
  foreignUnresolvedCount: number;
  instructionCoverage: number;
  instructionUnknownCount: number;
  coverage: ProjectHarnessCoverage;
  recoveryStatus: ProjectHarnessInspection["recovery"]["status"];
  recoveryReason: string | null;
}

export interface ProjectHarnessNotebookReleaseSelectors {
  notebookId: string;
  location: string;
  designatedWriterId: string;
  expectedRevision: ProjectHarnessFileRevision;
}

export type ProjectHarnessReadbackState =
  | { status: "fresh"; inspection: ProjectHarnessInspection }
  | { status: "rpc-error"; error: ProjectHarnessRpcError }
  | { status: "transport-error"; message: string };

export interface ProjectHarnessCommitState<TReceipt> {
  targetKey: string;
  receipt: TReceipt;
  readback: ProjectHarnessReadbackState;
}

export function acceptProjectHarnessCommit<TReceipt>(
  currentTargetKey: string,
  candidate: ProjectHarnessCommitState<TReceipt>,
): ProjectHarnessCommitState<TReceipt> | null {
  return candidate.targetKey === currentTargetKey ? candidate : null;
}

export function isProjectHarnessPlanConsumed<TReceipt>(
  state: ProjectHarnessCommitState<TReceipt> | null,
): boolean {
  return state !== null;
}

export function projectHarnessTargetKey(
  serverId: string,
  projectId: string,
  workspaceId: string,
): string {
  return JSON.stringify([serverId, projectId, workspaceId]);
}

export function resolveProjectHarnessNotebookReleaseSelectors(
  inspection: ProjectHarnessInspection,
): ProjectHarnessNotebookReleaseSelectors | null {
  const supervisorNotebook = inspection.metadata.supervisorNotebook;
  if (!supervisorNotebook) return null;
  return {
    notebookId: supervisorNotebook.notebookId,
    location: supervisorNotebook.location,
    designatedWriterId: supervisorNotebook.designatedWriterId,
    expectedRevision: inspection.metadata.revision,
  };
}

export function summarizeProjectHarnessInspection(
  inspection: ProjectHarnessInspection,
): ProjectHarnessInspectionSummary {
  const instructionUnknownCount = inspection.instructionVisibility.filter(
    (entry) => entry.status === "not_scanned" || entry.ownedBy === "unknown",
  ).length;
  const instructionCoverage = inspection.instructionVisibility.length;
  const foreignLocalDeltaCount = inspection.foreignOwnership.entries.filter(
    (entry) => entry.drift === "local_delta",
  ).length;
  const foreignUnresolvedCount = inspection.foreignOwnership.entries.filter(
    (entry) => entry.drift === "missing" || entry.drift === "unreadable",
  ).length;

  let coverage: ProjectHarnessCoverage;
  if (instructionCoverage === 0) {
    coverage = "unknown";
  } else if (instructionUnknownCount > 0) {
    coverage = "partial";
  } else {
    coverage = "complete";
  }

  return {
    relationship: inspection.relationship.kind,
    provenancePackage: inspection.provenance.package,
    provenanceGeneration: inspection.provenance.generation,
    provenanceArtifactDigest: inspection.provenance.artifactDigest,
    metadataStatus: inspection.metadata.status,
    foreignOwnershipStatus: inspection.foreignOwnership.status,
    foreignLocalDeltaCount,
    foreignUnresolvedCount,
    instructionCoverage,
    instructionUnknownCount,
    coverage,
    recoveryStatus: inspection.recovery.status,
    recoveryReason: inspection.recovery.reason ?? null,
  };
}

export function describeProjectHarnessChange(change: ProjectHarnessChange): string {
  return [`${change.action}: ${change.path}`, ...(change.reason ? [change.reason] : [])].join(
    " — ",
  );
}
