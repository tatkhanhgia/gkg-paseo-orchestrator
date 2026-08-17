import { z } from "zod";
import { AssignmentContractReceiptSchema } from "./assignment-contract.js";
import { HarnessBindingReceiptSchema } from "./harness-binding.js";
import { PolicyOwnerSchema } from "./policy-owner.js";

export const PASEO_ROLE_IDS = ["lead", "peer", "supervisor"] as const;

export const PaseoRoleIdSchema = z.enum(PASEO_ROLE_IDS);
export type PaseoRoleId = z.infer<typeof PaseoRoleIdSchema>;

export const PASEO_ROLE_CONTRACT_VERSION = "3.2.0-topology-recovery";

export const RoleBindingInjectionMethodSchema = z.enum([
  "codex-developer-instructions",
  "claude-system-prompt",
  "pi-before-agent-start",
  "omp-append-system-prompt",
  "cursor-project-rule-capsule",
  "cursor-always-apply-plugin",
  "antigravity-custom-agent",
  "grok-acp-session-rules",
  "mock-launch-context",
]);
export type RoleBindingInjectionMethod = z.infer<typeof RoleBindingInjectionMethodSchema>;

export const ACPNativeRoleBindingDriverSchema = z.enum([
  "cursor-workspace-rule",
  "cursor-plugin",
  "antigravity-custom-agent",
]);
export type ACPNativeRoleBindingDriver = z.infer<typeof ACPNativeRoleBindingDriverSchema>;

export const ProviderNativeRoleBindingConfigSchema = z.object({
  driver: ACPNativeRoleBindingDriverSchema,
});
export type ProviderNativeRoleBindingConfig = z.infer<typeof ProviderNativeRoleBindingConfigSchema>;

export const ProviderRoleBindingSupportSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("supported"),
    injectionMethod: RoleBindingInjectionMethodSchema,
    // COMPAT(providerRoleIds): added in v0.3.1-paseo.2; absence means all roles for old daemons.
    roleIds: z.array(PaseoRoleIdSchema).min(1).optional(),
    notice: z.string().optional(),
  }),
  z.object({
    status: z.literal("unsupported"),
    reason: z.string(),
    // An unavailable provider can still declare its policy admission set so
    // callers distinguish role denial from a separate transport blocker.
    roleIds: z.array(PaseoRoleIdSchema).min(1).optional(),
  }),
]);
export type ProviderRoleBindingSupport = z.infer<typeof ProviderRoleBindingSupportSchema>;

export function isProviderRoleBindingSupportedForRole(
  support: ProviderRoleBindingSupport | null | undefined,
  roleId: PaseoRoleId | null | undefined,
): boolean {
  return (
    roleId !== null &&
    roleId !== undefined &&
    support?.status === "supported" &&
    (support.roleIds === undefined || support.roleIds.includes(roleId))
  );
}

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const RoleProfileBindingReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileDigest: Sha256DigestSchema,
    defaults: z
      .object({
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        modeId: z.string().min(1).optional(),
        thinkingOptionId: z.string().min(1).optional(),
      })
      .strict(),
    allowedTools: z.array(z.string().min(1)),
    allowedSkills: z.array(z.string().min(1)),
  })
  .strict();
export type RoleProfileBindingReceipt = z.infer<typeof RoleProfileBindingReceiptSchema>;

export const WorkspaceProtocolBindingReceiptSchema = z.object({
  status: z.enum(["bound", "missing"]),
  readership: z.enum(["full", "assignment-only", "governance-only"]),
  path: z.string(),
  digest: Sha256DigestSchema.optional(),
});
export type WorkspaceProtocolBindingReceipt = z.infer<typeof WorkspaceProtocolBindingReceiptSchema>;

export const RoleBindingReceiptSchema = z.object({
  // COMPAT(policyOwner): role bindings persisted before bundled policy packs are legacy-core.
  policyOwner: PolicyOwnerSchema.optional(),
  roleId: PaseoRoleIdSchema,
  definitionVersion: z.string(),
  definitionDigest: Sha256DigestSchema,
  bindingDigest: Sha256DigestSchema,
  provider: z.string(),
  injectionMethod: RoleBindingInjectionMethodSchema,
  qualification: z.literal("implementation-supported"),
  workspaceProtocol: WorkspaceProtocolBindingReceiptSchema,
  // COMPAT(assignmentContracts): added in v0.3.0-beta.1.paseo.2; old persisted agents omit it.
  assignment: AssignmentContractReceiptSchema.optional(),
  // COMPAT(roleProfiles): agents created before host role profiles omit this immutable snapshot.
  roleProfile: RoleProfileBindingReceiptSchema.optional(),
  // COMPAT(harnessBinding): added in R1; legacy persisted bindings omit the
  // receipt and must not be used for a new SLP launch.
  harnessBinding: HarnessBindingReceiptSchema.optional(),
  createdAt: z.string(),
});
export type RoleBindingReceipt = z.infer<typeof RoleBindingReceiptSchema>;
