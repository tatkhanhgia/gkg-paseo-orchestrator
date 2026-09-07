import { describe, expect, test } from "vitest";

import {
  serializeSupervisorNotebookRecord,
  SupervisorNotebookRecordSchema,
} from "./notebook-record.js";

const RECORD = {
  schemaVersion: 1 as const,
  recordId: "episode-1",
  episode: "runtime-binding",
  scope: "R1 bounded notebook authority",
  observation: "A provider launch failed after admission preparation.",
  evidence: ["provider launch receipt"],
  suspectedMechanism: { status: "unknown" as const, statement: "Not yet established." },
  impact: "authority" as const,
  questionForLead: "Should the launch route be retried?",
  recovery: "The pending writer claim was rolled back.",
  outcome: "No unauthorized durable claim remained.",
  patternStatus: "one-off" as const,
  recommendation: "Keep the receipt pinned across the next resume.",
  escalation: "lead" as const,
  currentEpisode: "Observed" as const,
  laterEffect: "Unobserved" as const,
  laterEffectEvidenceRefs: [] as const,
  observedAt: "2026-09-07T00:00:00.000Z",
};

describe("SupervisorNotebookRecordSchema", () => {
  test("accepts and serializes the bounded causal/disproof record", () => {
    const parsed = SupervisorNotebookRecordSchema.parse(RECORD);
    const serialized = serializeSupervisorNotebookRecord(parsed);
    expect(serialized).toContain("paseo-supervisor-notebook-record-v1");
    expect(serialized).toContain('"laterEffect":"Unobserved"');
  });

  test("rejects unbounded or malformed episode evidence", () => {
    expect(() =>
      SupervisorNotebookRecordSchema.parse({
        ...RECORD,
        laterEffect: "unknown",
      }),
    ).toThrow();
    expect(() =>
      SupervisorNotebookRecordSchema.parse({
        ...RECORD,
        observation: "x".repeat(5_001),
      }),
    ).toThrow();
  });

  test("requires dedicated later-episode evidence when laterEffect is Observed", () => {
    expect(() =>
      SupervisorNotebookRecordSchema.parse({
        ...RECORD,
        laterEffect: "Observed",
        laterEffectEvidenceRefs: [],
      }),
    ).toThrow(/laterEffect Observed requires comparable later-episode evidence/u);
  });
});
