import { describe, expect, test } from "vitest";

import { materializeAssignmentContract } from "./assignment-contract.js";
import {
  buildAgentEpisodeReport,
  EpisodeReportRequestSchema,
  type AgentEpisodeReportSources,
} from "./agent-episode-report.js";
import { SLP_EPISODE_REPORT_POLICY } from "../policy/bundled/slp/checkpoint-policy.js";
import type { LeadHandoffPacket } from "@getpaseo/protocol/lead-handoff";
import { SupervisorNotebookRecordSchema } from "@getpaseo/protocol/notebook-record";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const ISSUE_ID = "episode-issue";
const TARGET_ID = "episode-target";
const PROJECT_ID = "episode-project";
const OBJECTIVE = "Produce one bounded episode report.";
const ASSIGNMENT = materializeAssignmentContract({
  roleId: "peer",
  assigner: { kind: "human-session" },
  workspaceId: "episode-workspace",
  cwd: "/episode-repo",
  envelope: {
    version: 1,
    disposition: "peer-execution",
    objective: OBJECTIVE,
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    resourceGrants: { beadsIssueIds: [ISSUE_ID] },
    evidence: "Use canonical source pointers.",
    handbackAndStop: "Return the report and stop.",
  },
  createdAt: new Date("2026-09-06T10:00:00.000Z"),
});

function notebookRecord(input: {
  recordId: string;
  episode: string;
  observedAt: string;
  laterEffect?: "Observed" | "Unobserved";
  laterEffectEvidenceRefs?: string[];
  suspectedMechanism?: "hypothesis" | "unknown" | "disproved" | "supported";
  patternStatus?: "one-off" | "repeated" | "durable" | "disproved";
  evidence?: string[];
}) {
  return SupervisorNotebookRecordSchema.parse({
    schemaVersion: 1,
    recordId: input.recordId,
    episode: input.episode,
    scope: "episode-scope",
    observation: "The bounded evidence was recorded.",
    evidence: input.evidence ?? ["candidate-good", "source:canonical"],
    suspectedMechanism: {
      status: input.suspectedMechanism ?? "unknown",
      statement: "Mechanism remains a bounded notebook claim.",
    },
    impact: "quality",
    questionForLead: "Does the evidence warrant a Lead decision?",
    recovery: "Keep the report read-only.",
    outcome: "A source-linked report exists.",
    patternStatus: input.patternStatus ?? "one-off",
    recommendation: "Review the evidence without promoting a rule.",
    escalation: "lead",
    currentEpisode: "Observed",
    laterEffect: input.laterEffect ?? "Unobserved",
    laterEffectEvidenceRefs: input.laterEffectEvidenceRefs ?? [],
    observedAt: input.observedAt,
  });
}

function reportRequest(overrides: Record<string, unknown> = {}) {
  return EpisodeReportRequestSchema.parse({
    episodeId: "episode-1",
    projectId: PROJECT_ID,
    assignmentDigest: ASSIGNMENT.receipt.assignmentDigest,
    issueId: ISSUE_ID,
    objective: OBJECTIVE,
    window: {
      from: "2026-09-06T09:00:00.000Z",
      to: "2026-09-06T12:00:00.000Z",
      maxActivityItems: 10,
    },
    candidate: { ref: "candidate-good" },
    ...overrides,
  });
}

function sources(
  records: AgentEpisodeReportSources["notebook"]["records"] = [],
  handoff: AgentEpisodeReportSources["handoff"]["packets"] = [],
  activity: AgentEpisodeReportSources["activity"]["rows"] = [],
): AgentEpisodeReportSources {
  return {
    callerAgentId: "episode-caller",
    targetAgentId: TARGET_ID,
    callerRoleId: "lead",
    relationshipToTarget: "owns-target",
    readAuthorization: { authorized: true, reason: "test relationship" },
    checkpoint: {
      agentId: TARGET_ID,
      disposition: "unknown",
      waitingOn: [],
      evidence: [],
      allowedNextSteps: [],
      unknowns: [],
    },
    assignment: {
      receipt: ASSIGNMENT.receipt,
      objective: ASSIGNMENT.envelope.objective,
      effectClass: ASSIGNMENT.envelope.effectClass,
      roleId: "peer",
      handbackAndStop: ASSIGNMENT.envelope.handbackAndStop,
      evidence: ASSIGNMENT.envelope.evidence,
    },
    project: {
      status: "available",
      projectId: PROJECT_ID,
      workspaceId: "episode-workspace",
      cwd: "/episode-repo",
      rootPath: "/episode-repo",
    },
    beads: {
      accessible: true,
      issue: {
        issueId: ISSUE_ID,
        status: "in_progress",
        assigneeAgentId: TARGET_ID,
        openDependencyCount: null,
        boundTargetAgentId: TARGET_ID,
        dependencyDataComplete: false,
      },
    },
    activity: { status: "available", rows: activity, truncated: false },
    notebook: {
      status: "available",
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      revision: null,
      records,
      parseErrors: 0,
    },
    handoff: { status: "available", packets: handoff },
  };
}

function handoffPacket(): LeadHandoffPacket {
  return {
    id: "handoff-1",
    workspaceId: "episode-workspace",
    predecessorAgentId: "episode-predecessor",
    successorAgentId: null,
    currentWriteOwnerAgentId: TARGET_ID,
    objective: OBJECTIVE,
    scope: ["episode-scope"],
    currentState: "The bounded report is ready for review.",
    decisions: [],
    failedApproaches: [],
    successfulPatterns: [],
    evidenceIndex: [{ ref: "candidate-good", claim: "Candidate was mentioned in handback." }],
    activeRisksAndBlockers: [],
    exactResumePoint: "Review the bounded report.",
    stopCondition: "Stop after review.",
    status: "packet_ready",
    createdAt: "2026-09-06T11:00:00.000Z",
    receipts: [],
  };
}

describe("bounded SLP episode report", () => {
  test("keeps a record's Unobserved later effect as unknown", () => {
    const current = notebookRecord({
      recordId: "episode-record-1",
      episode: "episode-1",
      observedAt: "2026-09-06T10:00:00.000Z",
    });
    const report = buildAgentEpisodeReport(
      sources([current]),
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.status).toBe("reportable");
    expect(report.notebook.records).toEqual([current]);
    expect(report.dimensions.laterEffect.status).toBe("unknown");
    expect(report.dimensions.laterEffect.sourceFacts[0]?.summary).toContain(
      "fact about the record",
    );
    expect(report.dimensions.outcome.status).toBe("unknown");
    expect(report.dimensions.leadAcceptance.status).toBe("unobserved");
  });

  test("keeps missing or non-matching notebook evidence unknown", () => {
    const noMatchingRecord = buildAgentEpisodeReport(
      sources(),
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );
    expect(noMatchingRecord.dimensions.laterEffect.status).toBe("unknown");
    expect(noMatchingRecord.dimensions.outcome.status).toBe("unknown");
    expect(noMatchingRecord.dimensions.laterEffect.inference).toContain(
      "record absence does not establish",
    );

    const missingNotebook = sources();
    missingNotebook.notebook = {
      status: "missing",
      location: null,
      revision: null,
      records: [],
      parseErrors: 0,
      reason: "no canonical notebook file",
    };
    const missing = buildAgentEpisodeReport(
      missingNotebook,
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );
    expect(missing.dimensions.laterEffect.status).toBe("unknown");
    expect(missing.dimensions.outcome.status).toBe("unknown");
  });

  test("preserves candidate digest mismatch and notebook disproof without accepting it", () => {
    const disproof = notebookRecord({
      recordId: "episode-record-disproof",
      episode: "episode-1",
      observedAt: "2026-09-06T10:00:00.000Z",
      suspectedMechanism: "disproved",
      patternStatus: "disproved",
      evidence: ["candidate-good", `candidate-digest=${"b".repeat(64)}`],
    });
    const report = buildAgentEpisodeReport(
      sources([disproof]),
      reportRequest({ candidate: { ref: "candidate-good", digest: "a".repeat(64) } }),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.lineage.candidate.status).toBe("unknown");
    expect(report.lineage.candidate.inference).toContain("candidate_mismatch");
    expect(report.notebook.records[0]?.suspectedMechanism.status).toBe("disproved");
    expect(report.notebook.records[0]?.patternStatus).toBe("disproved");
    expect(report.dimensions.causalInterpretation.status).toBe("present");
    expect(report.dimensions.leadAcceptance.status).toBe("unobserved");
  });

  test("keeps an asserted later effect unknown until its later source joins", () => {
    const current = notebookRecord({
      recordId: "episode-record-asserted",
      episode: "episode-1",
      observedAt: "2026-09-06T10:00:00.000Z",
      laterEffect: "Observed",
      laterEffectEvidenceRefs: ["later-record-missing"],
    });
    const report = buildAgentEpisodeReport(
      sources([current]),
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.dimensions.laterEffect.status).toBe("unknown");
    expect(report.dimensions.outcome.status).toBe("unknown");
    expect(report.dimensions.outcome.claims.length).toBeGreaterThan(0);
  });

  test("does not promote same-episode or contradictory notebook claims to later effect", () => {
    const current = notebookRecord({
      recordId: "episode-1",
      episode: "episode-1",
      observedAt: "2026-09-06T10:00:00.000Z",
      laterEffect: "Observed",
      laterEffectEvidenceRefs: ["later-record", "disproved-record"],
    });
    const later = notebookRecord({
      recordId: "later-record",
      episode: "episode-1",
      observedAt: "2026-09-06T11:00:00.000Z",
      suspectedMechanism: "supported",
    });
    const disproved = notebookRecord({
      recordId: "disproved-record",
      episode: "episode-1",
      observedAt: "2026-09-06T11:30:00.000Z",
      suspectedMechanism: "disproved",
      patternStatus: "disproved",
    });
    const report = buildAgentEpisodeReport(
      sources([current, later, disproved]),
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.notebook.matchedRecordIds).toEqual([
      "episode-1",
      "later-record",
      "disproved-record",
    ]);
    expect(report.dimensions.laterEffect.status).toBe("unknown");
    expect(report.dimensions.outcome.status).toBe("unknown");
    expect(report.dimensions.causalInterpretation.status).toBe("unknown");
  });

  test("does not join an unrelated later episode that shares scope or refs", () => {
    const current = notebookRecord({
      recordId: "episode-current",
      episode: "episode-1",
      observedAt: "2026-09-06T10:00:00.000Z",
      laterEffect: "Observed",
      laterEffectEvidenceRefs: ["shared-later-ref"],
    });
    const unrelated = notebookRecord({
      recordId: "unrelated-later",
      episode: "another-episode",
      observedAt: "2026-09-06T11:00:00.000Z",
      evidence: ["shared-later-ref"],
    });
    const report = buildAgentEpisodeReport(
      sources([current, unrelated]),
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.notebook.records).toHaveLength(1);
    expect(report.notebook.matchedRecordIds).toEqual(["episode-current"]);
    expect(report.dimensions.laterEffect.status).toBe("unknown");
    expect(report.dimensions.outcome.status).toBe("unknown");
  });

  test("does not validate a candidate from an unrelated digest or outside-window activity", () => {
    const current = notebookRecord({
      recordId: "episode-current",
      episode: "episode-1",
      observedAt: "2026-09-06T10:00:00.000Z",
      evidence: ["candidate-good"],
    });
    const unrelated = notebookRecord({
      recordId: "unrelated-candidate",
      episode: "another-episode",
      observedAt: "2026-09-06T11:00:00.000Z",
      evidence: [`candidate-digest=${"b".repeat(64)}`],
    });
    const outsideWindow: AgentTimelineRow = {
      seq: 20,
      timestamp: "2026-09-06T13:00:00.000Z",
      item: { type: "assistant_message", text: `candidate-good ${"b".repeat(64)}` },
    };
    const report = buildAgentEpisodeReport(
      sources([current, unrelated], [], [outsideWindow]),
      reportRequest({ candidate: { ref: "candidate-good", digest: "b".repeat(64) } }),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.dimensions.activity.status).toBe("unobserved");
    expect(report.lineage.candidate.status).toBe("unknown");
    expect(report.lineage.candidate.inference).toContain("candidate_mismatch");
  });

  test("does not prove a candidate from an inside-window assistant mention", () => {
    const digest = "a".repeat(64);
    const report = buildAgentEpisodeReport(
      sources(
        [],
        [],
        [
          {
            seq: 1,
            timestamp: "2026-09-06T10:01:00.000Z",
            item: { type: "assistant_message", text: `candidate-good ${digest}` },
          },
        ],
      ),
      reportRequest({ candidate: { ref: "candidate-good", digest } }),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.lineage.candidate.status).toBe("unknown");
    expect(report.lineage.candidate.inference).toContain("candidate_mismatch");
    expect(report.lineage.candidate.sourceFacts).toEqual([]);
    expect(report.lineage.candidate.claims).toEqual([
      expect.objectContaining({
        pointer: "timeline:1",
        sourceClass: "agent-claim",
      }),
    ]);
  });

  test("does not collect digests from authored command, search, todo, or error text", () => {
    const digest = "b".repeat(64);
    const report = buildAgentEpisodeReport(
      sources(
        [],
        [],
        [
          {
            seq: 1,
            timestamp: "2026-09-06T10:01:00.000Z",
            item: {
              type: "tool_call",
              callId: "shell-echo",
              name: "run_command",
              status: "completed",
              error: null,
              detail: { type: "shell", command: `echo candidate-good ${digest}`, exitCode: 0 },
            },
          },
          {
            seq: 2,
            timestamp: "2026-09-06T10:02:00.000Z",
            item: {
              type: "tool_call",
              callId: "search-echo",
              name: "search",
              status: "completed",
              error: null,
              detail: { type: "search", query: `candidate-good ${digest}` },
            },
          },
          {
            seq: 3,
            timestamp: "2026-09-06T10:03:00.000Z",
            item: {
              type: "todo",
              items: [{ text: `candidate-good ${digest}`, completed: false }],
            },
          },
          {
            seq: 4,
            timestamp: "2026-09-06T10:04:00.000Z",
            item: { type: "error", message: `candidate-good ${digest}` },
          },
        ],
      ),
      reportRequest({ candidate: { ref: "candidate-good", digest } }),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.lineage.candidate.status).toBe("unknown");
    expect(report.lineage.candidate.inference).toContain("candidate_mismatch");
    expect(report.lineage.candidate.sourceFacts).toEqual([]);
    expect(report.lineage.candidate.claims).toHaveLength(4);
    expect(
      report.lineage.candidate.claims.every((entry) => entry.sourceClass === "agent-claim"),
    ).toBe(true);
  });

  test("uses an exact typed checkpoint receipt as candidate evidence", () => {
    const digest = "c".repeat(64);
    const reportSources = sources();
    reportSources.checkpoint = {
      ...reportSources.checkpoint!,
      evidence: [
        {
          kind: "assignment",
          pointer: digest,
          summary: `Pinned assignment receipt ${digest}`,
        },
      ],
    };
    const report = buildAgentEpisodeReport(
      reportSources,
      reportRequest({ candidate: { ref: digest, digest } }),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.lineage.candidate.status).toBe("present");
    expect(report.lineage.candidate.observed).toBe(digest);
    expect(report.lineage.candidate.sourceFacts).toEqual([
      expect.objectContaining({ pointer: `checkpoint:assignment:${digest}` }),
    ]);
  });

  test("excludes reasoning text and preserves successful and failed check facts", () => {
    const reasoning: AgentTimelineRow = {
      seq: 1,
      timestamp: "2026-09-06T10:01:00.000Z",
      item: { type: "reasoning", text: `candidate-good ${"c".repeat(64)}` },
    };
    const success: AgentTimelineRow = {
      seq: 2,
      timestamp: "2026-09-06T10:02:00.000Z",
      item: {
        type: "tool_call",
        callId: "success",
        name: "run_command",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm run test", exitCode: 0 },
      },
    };
    const failure: AgentTimelineRow = {
      seq: 3,
      timestamp: "2026-09-06T10:03:00.000Z",
      item: {
        type: "tool_call",
        callId: "failure",
        name: "run_command",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm run typecheck", exitCode: 1 },
      },
    };
    const report = buildAgentEpisodeReport(
      sources([], [], [reasoning, success, failure]),
      reportRequest({ candidate: { ref: "candidate-good" } }),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.lineage.candidate.status).toBe("unobserved");
    expect(report.dimensions.testPass.status).toBe("exercised");
    expect(report.dimensions.testPass.sourceFacts).toHaveLength(2);
    expect(report.dimensions.testPass.sourceFacts.map((entry) => entry.pointer)).toEqual([
      "timeline:2",
      "timeline:3",
    ]);
    expect(report.dimensions.testPass.inference).toContain("Both successful and failed");
  });

  test("keeps handoff/objective matching as an ambiguous claim join", () => {
    const report = buildAgentEpisodeReport(
      sources([], [handoffPacket()]),
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.lineage.candidate.status).toBe("unknown");
    expect(report.lineage.candidate.claims[0]?.summary).toContain("weakly claims");
    expect(report.dimensions.handback.status).toBe("unknown");
    expect(report.dimensions.handback.inference).toContain("exact episode");
  });

  test("keeps missing activity unknown rather than treating it as unobserved", () => {
    const missingActivity = sources();
    missingActivity.activity = {
      status: "missing",
      rows: [],
      truncated: false,
      reason: "no durable source",
    };
    const report = buildAgentEpisodeReport(
      missingActivity,
      reportRequest(),
      SLP_EPISODE_REPORT_POLICY,
    );

    expect(report.dimensions.activity.status).toBe("unknown");
    expect(report.dimensions.testPass.status).toBe("unknown");
    expect(report.lineage.candidate.status).toBe("unknown");
  });
});
