import { z } from "zod";

/**
 * Human-curated catalog of outside-workspace grants.
 *
 * The catalog only feeds the composer UI: a checked entry contributes its `grant` text to
 * `resourceGrants.externalEffects`, which is what the assignment contract actually derives from.
 * Nothing here widens a boundary on its own, and the daemon never reads the catalog when it
 * validates a contract.
 *
 * The stable `id` is the point of the catalog. Free-text grants can never be enforced or audited
 * because two assignments that mean the same thing spell it differently; an id can carry a real
 * gate later without changing the wire shape.
 */
export const ExternalEffectCatalogEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u, "Use lowercase letters, digits, dot, dash, underscore"),
    label: z.string().min(1).max(120),
    grant: z.string().min(1).max(500),
  })
  .strict();

/** Capped well above the 32 grants an assignment may carry, so the catalog is never the limit. */
export const ExternalEffectCatalogSchema = z
  .array(ExternalEffectCatalogEntrySchema)
  .max(64)
  .superRefine((entries, context) => {
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Catalog ids must be unique" });
    }
  });

export type ExternalEffectCatalogEntry = z.infer<typeof ExternalEffectCatalogEntrySchema>;
export type ExternalEffectCatalog = z.infer<typeof ExternalEffectCatalogSchema>;
