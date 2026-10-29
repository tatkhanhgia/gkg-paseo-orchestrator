import { z } from "zod";

export const PeerSubroleSchema = z.enum(["scout", "engineer", "reviewer", "architect"]);
export type PeerSubrole = z.infer<typeof PeerSubroleSchema>;

/**
 * A named launch bundle: a provider plus the agent-config values a client would
 * otherwise set one control at a time. Field names mirror `AgentSessionConfig`
 * so applying a profile is a copy rather than a translation table.
 *
 * There is deliberately no system prompt here. `AgentSessionConfig.systemPrompt`
 * is creation-only, so a profile carrying one would apply when starting a new
 * agent and silently do nothing when applied to a running one.
 */
export const AgentProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** A key into the client's icon registry, not a glyph. Unknown keys draw the default. */
    icon: z.string().optional(),
    /** An identity colour name shared with host badges. Unknown values draw unthemed. */
    color: z.string().optional(),
    provider: z.string(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    /** Free text, surfaced to orchestrating agents by the `list_profiles` MCP tool. */
    notes: z.string().optional(),
    /**
     * Human-authored routing metadata for Lead-to-Peer selection. This never
     * grants role identity, execution specialization, mutation, or acceptance authority.
     */
    peerSubrole: PeerSubroleSchema.optional(),
  })
  .passthrough();

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Immutable snapshot of the Human-approved Agent Profile used for one launch. */
export const AgentProfileLaunchReceiptSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    peerSubrole: PeerSubroleSchema.optional(),
  })
  .strict();

export type AgentProfileLaunchReceipt = z.infer<typeof AgentProfileLaunchReceiptSchema>;

export const AgentSkillSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("custom"), skills: z.array(z.string()) }).strict(),
]);
export type AgentSkillSelection = z.infer<typeof AgentSkillSelectionSchema>;
