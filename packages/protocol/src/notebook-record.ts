import { z } from "zod";

const NotebookEvidenceReferenceSchema = z.string().trim().min(1).max(500);

/**
 * Bounded, history-preserving Supervisor notebook record owned by R1. E1 can
 * project episode reports from this shape without redefining the notebook's
 * causal/disproof vocabulary.
 */
export const SupervisorNotebookRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordId: z.string().trim().min(1).max(160),
    episode: z.string().trim().min(1).max(500),
    scope: z.string().trim().min(1).max(1_000),
    observation: z.string().trim().min(1).max(5_000),
    evidence: z.array(NotebookEvidenceReferenceSchema).max(32),
    suspectedMechanism: z
      .object({
        status: z.enum(["hypothesis", "unknown", "disproved", "supported"]),
        statement: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    impact: z.enum(["momentum", "ownership", "attention", "quality", "authority"]),
    questionForLead: z.string().trim().max(2_000),
    recovery: z.string().trim().min(1).max(4_000),
    outcome: z.string().trim().min(1).max(4_000),
    patternStatus: z.enum(["one-off", "repeated", "durable", "disproved"]),
    recommendation: z.string().trim().min(1).max(3_000),
    escalation: z.enum(["no", "lead", "human"]),
    currentEpisode: z.enum(["Observed", "Unobserved"]),
    laterEffect: z.enum(["Observed", "Unobserved"]),
    laterEffectEvidenceRefs: z.array(NotebookEvidenceReferenceSchema).max(32),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.laterEffect === "Observed" && record.laterEffectEvidenceRefs.length === 0) {
      context.addIssue({
        code: "custom",
        message: "laterEffect Observed requires comparable later-episode evidence references",
        path: ["laterEffectEvidenceRefs"],
      });
    }
  });

export type SupervisorNotebookRecord = z.infer<typeof SupervisorNotebookRecordSchema>;

export function serializeSupervisorNotebookRecord(record: SupervisorNotebookRecord): string {
  const parsed = SupervisorNotebookRecordSchema.parse(record);
  return `<!-- paseo-supervisor-notebook-record-v1 -->\n${JSON.stringify(parsed)}`;
}
