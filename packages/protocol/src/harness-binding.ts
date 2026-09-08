import { z } from "zod";

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** One immutable resource selected by a role's Project Harness minimum. */
export const HarnessResourceReceiptSchema = z
  .object({
    key: z.string().trim().min(1),
    path: z.string().trim().min(1),
    digest: Sha256DigestSchema,
  })
  .strict();
export type HarnessResourceReceipt = z.infer<typeof HarnessResourceReceiptSchema>;

/** Durable project notebook read context carried by every SLP Supervisor binding. */
export const SupervisorNotebookBindingSchema = z
  .object({
    notebookId: z.string().trim().min(1),
    location: z.string().trim().min(1),
    projectScope: z.string().trim().min(1),
    reportingTarget: z.string().trim().min(1),
    designatedWriterId: z.string().trim().min(1).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type SupervisorNotebookBinding = z.infer<typeof SupervisorNotebookBindingSchema>;

/**
 * Immutable receipt for the imported Project Harness package and its role
 * minimum. The generic host persists this shape; SLP policy owns how the
 * package and resource set are selected.
 */
export const HarnessBindingReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: z.string().trim().min(1),
    generation: z.number().int().positive(),
    artifactDigest: Sha256DigestSchema,
    descriptorPath: z.string().trim().min(1),
    descriptorDigest: Sha256DigestSchema,
    resources: z.array(HarnessResourceReceiptSchema).min(1),
    projectId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    // Optional for backward parsing of pre-R1 persisted receipts. New SLP
    // receipts always carry the exact registered workspace root separately
    // from the agent's child cwd.
    workspaceRoot: z.string().trim().min(1).optional(),
    projectRoot: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    notebook: SupervisorNotebookBindingSchema.optional(),
  })
  .strict();
export type HarnessBindingReceipt = z.infer<typeof HarnessBindingReceiptSchema>;

/** Project identity and durable notebook projection supplied by Product. */
export interface HarnessBindingContext {
  projectId: string;
  workspaceId: string;
  workspaceRoot: string;
  projectRoot: string;
  cwd: string;
  notebook?: SupervisorNotebookBinding;
}
