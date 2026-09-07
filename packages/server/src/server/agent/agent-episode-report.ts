import type {
  AssignmentContractReceipt,
  AssignmentEffectClass,
} from "@getpaseo/protocol/assignment-contract";
import type { LeadHandoffPacket } from "@getpaseo/protocol/lead-handoff";
import type { SupervisorNotebookRecord } from "@getpaseo/protocol/notebook-record";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import { z } from "zod";

import type {
  AgentCheckpointResult,
  AgentCheckpointSources,
  CheckpointBeadsSnapshot,
  CheckpointCallerRelationship,
} from "./agent-checkpoint.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/u);
const BOUNDED_TEXT_SCHEMA = z.string().trim().min(1).max(1_000);
const REF_SCHEMA = z.string().trim().min(1).max(500);

const EpisodeWindowSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    maxActivityItems: z.number().int().positive().max(100).default(25),
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.from) >= Date.parse(window.to)) {
      context.addIssue({
        code: "custom",
        message: "episode window.from must be earlier than window.to",
        path: ["from"],
      });
    }
  });

const EpisodeRevisionSchema = z
  .object({
    mtimeMs: z.number().finite().nonnegative(),
    size: z.number().int().nonnegative(),
    sha256: SHA256_SCHEMA,
  })
  .strict();

const EpisodeCandidateSchema = z
  .object({
    ref: REF_SCHEMA,
    digest: SHA256_SCHEMA.optional(),
    evidenceRefs: z.array(REF_SCHEMA).max(32).optional(),
  })
  .strict();

/**
 * Explicit identity for one bounded episode report. A session, issue, or
 * notebook record is not an episode until a caller supplies this request.
 */
export const EpisodeReportRequestSchema = z
  .object({
    episodeId: BOUNDED_TEXT_SCHEMA.max(160),
    projectId: BOUNDED_TEXT_SCHEMA.max(200),
    assignmentDigest: SHA256_SCHEMA,
    issueId: BOUNDED_TEXT_SCHEMA.max(128),
    objective: BOUNDED_TEXT_SCHEMA,
    window: EpisodeWindowSchema,
    candidate: EpisodeCandidateSchema.optional(),
    notebookRevision: EpisodeRevisionSchema.optional(),
  })
  .strict();

export type EpisodeReportRequest = z.infer<typeof EpisodeReportRequestSchema>;

export const EPISODE_REPORT_SCHEMA_VERSION = 1 as const;

export type EpisodeEvidenceStatus =
  | "present"
  | "wired"
  | "exercised"
  | "outcome-supported"
  | "missing"
  | "unobserved"
  | "not-applicable"
  | "unknown";

export type EpisodeSourceReadStatus =
  | "available"
  | "missing"
  | "unavailable"
  | "stale"
  | "ambiguous";

export type EpisodeEvidenceClass = "source-fact" | "agent-claim" | "derived-inference";

export interface EpisodeEvidenceEntry {
  sourceClass: EpisodeEvidenceClass;
  pointer: string;
  summary: string;
}

export interface EpisodeDimension {
  status: EpisodeEvidenceStatus;
  sourceFacts: readonly EpisodeEvidenceEntry[];
  claims: readonly EpisodeEvidenceEntry[];
  inference: string | null;
}

export interface EpisodeLineageField extends EpisodeDimension {
  requested: string | null;
  observed: string | null;
}

export interface EpisodeAssignmentSource {
  receipt: AssignmentContractReceipt;
  objective: string;
  effectClass: AssignmentEffectClass;
  roleId: PaseoRoleId;
  handbackAndStop: string;
  evidence: string;
}

export interface EpisodeProjectSource {
  status: EpisodeSourceReadStatus;
  projectId: string | null;
  workspaceId: string | null;
  cwd: string | null;
  rootPath: string | null;
  reason?: string;
}

export interface EpisodeActivitySource {
  status: EpisodeSourceReadStatus;
  rows: readonly AgentTimelineRow[];
  truncated: boolean;
  reason?: string;
}

export interface EpisodeNotebookSource {
  status: EpisodeSourceReadStatus;
  location: string | null;
  revision: {
    mtimeMs: number;
    size: number;
    sha256: string;
  } | null;
  records: readonly SupervisorNotebookRecord[];
  parseErrors: number;
  reason?: string;
}

export interface EpisodeHandoffSource {
  status: EpisodeSourceReadStatus;
  packets: readonly LeadHandoffPacket[];
  reason?: string;
}

export interface AgentEpisodeReportSources {
  callerAgentId: string;
  targetAgentId: string;
  callerRoleId: PaseoRoleId | null;
  relationshipToTarget: CheckpointCallerRelationship;
  readAuthorization: AgentCheckpointSources["readAuthorization"];
  checkpoint: AgentCheckpointResult | null;
  assignment: EpisodeAssignmentSource | null;
  project: EpisodeProjectSource;
  beads: CheckpointBeadsSnapshot;
  activity: EpisodeActivitySource;
  notebook: EpisodeNotebookSource;
  handoff: EpisodeHandoffSource;
}

export interface EpisodeReportAuthorityBoundary {
  reportMayGrantWriter: false;
  reportMayMutateBeads: false;
  reportMayAccept: false;
  reportMayPromoteRule: false;
}

export interface AgentEpisodeReport {
  schemaVersion: typeof EPISODE_REPORT_SCHEMA_VERSION;
  episodeId: string;
  status: "unauthorized" | "unknown" | "reportable";
  lineage: {
    project: EpisodeLineageField;
    assignment: EpisodeLineageField;
    issue: EpisodeLineageField;
    candidate: EpisodeLineageField;
    evidence: EpisodeLineageField;
  };
  dimensions: {
    wiring: EpisodeDimension;
    activity: EpisodeDimension;
    evidence: EpisodeDimension;
    testPass: EpisodeDimension;
    delivery: EpisodeDimension;
    handback: EpisodeDimension;
    leadAcceptance: EpisodeDimension;
    outcome: EpisodeDimension;
    laterEffect: EpisodeDimension;
    causalInterpretation: EpisodeDimension;
  };
  notebook: {
    status: EpisodeSourceReadStatus;
    location: string | null;
    matchedRecordIds: readonly string[];
    records: readonly SupervisorNotebookRecord[];
  };
  sourceFacts: readonly EpisodeEvidenceEntry[];
  claims: readonly EpisodeEvidenceEntry[];
  inferences: readonly string[];
  unknowns: readonly string[];
  authority: EpisodeReportAuthorityBoundary;
}

export interface EpisodeReportPolicy {
  id: string;
  version: string;
  project(sources: AgentEpisodeReportSources, request: EpisodeReportRequest): AgentEpisodeReport;
}

const NO_AUTHORITY: EpisodeReportAuthorityBoundary = {
  reportMayGrantWriter: false,
  reportMayMutateBeads: false,
  reportMayAccept: false,
  reportMayPromoteRule: false,
};

function emptyDimension(
  status: EpisodeEvidenceStatus,
  inference: string | null = null,
): EpisodeDimension {
  return { status, sourceFacts: [], claims: [], inference };
}

function emptyLineage(
  requested: string | null,
  status: EpisodeEvidenceStatus,
  inference: string | null = null,
): EpisodeLineageField {
  return { requested, observed: null, ...emptyDimension(status, inference) };
}

function unauthorizedEpisodeReport(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
): AgentEpisodeReport {
  const reason = sources.readAuthorization.reason;
  const unknown = `episode_report_not_authorized: ${reason}`;
  return {
    schemaVersion: EPISODE_REPORT_SCHEMA_VERSION,
    episodeId: request.episodeId,
    status: "unauthorized",
    lineage: {
      project: emptyLineage(request.projectId, "unknown", unknown),
      assignment: emptyLineage(request.assignmentDigest, "unknown", unknown),
      issue: emptyLineage(request.issueId, "unknown", unknown),
      candidate: emptyLineage(request.candidate?.ref ?? null, "unknown", unknown),
      evidence: emptyLineage(null, "unknown", unknown),
    },
    dimensions: {
      wiring: emptyDimension("unknown", unknown),
      activity: emptyDimension("unknown", unknown),
      evidence: emptyDimension("unknown", unknown),
      testPass: emptyDimension("unknown", unknown),
      delivery: emptyDimension("unknown", unknown),
      handback: emptyDimension("unknown", unknown),
      leadAcceptance: emptyDimension("unknown", unknown),
      outcome: emptyDimension("unknown", unknown),
      laterEffect: emptyDimension("unknown", unknown),
      causalInterpretation: emptyDimension("unknown", unknown),
    },
    notebook: {
      status: "unavailable",
      location: null,
      matchedRecordIds: [],
      records: [],
    },
    sourceFacts: [],
    claims: [],
    inferences: [],
    unknowns: [unknown],
    authority: NO_AUTHORITY,
  };
}

/**
 * Generic host entrypoint. It enforces the authorization short circuit and
 * delegates all interpretation to the selected policy pack.
 */
export function buildAgentEpisodeReport(
  sources: AgentEpisodeReportSources,
  request: EpisodeReportRequest,
  policy: EpisodeReportPolicy,
): AgentEpisodeReport {
  if (!sources.readAuthorization.authorized) {
    return unauthorizedEpisodeReport(sources, request);
  }
  return policy.project(sources, request);
}
