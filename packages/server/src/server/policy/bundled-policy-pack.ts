import { createHash } from "node:crypto";
import {
  PolicyOwnerSchema,
  PolicyPluginIdSchema,
  type PolicyOwner,
} from "@getpaseo/protocol/policy-owner";
import { z } from "zod";

export const BUNDLED_POLICY_PACK_ABI_VERSION = 1 as const;
export const SLP_BUNDLED_POLICY_PLUGIN_ID = "slp" as const;

const RESERVED_BUNDLED_POLICY_PLUGIN_IDS = new Set<string>([SLP_BUNDLED_POLICY_PLUGIN_ID]);

export const BundledPolicyPackManifestSchema = z
  .object({
    // Bundled packs are trusted server contributions. Keep the plugin-id wire
    // shape aligned with PolicyOwner so a generation can be pinned without a
    // second, narrower SLP-only ABI. Public/local plugin admission still
    // reserves the SLP id below.
    id: PolicyPluginIdSchema,
    abiVersion: z.literal(BUNDLED_POLICY_PACK_ABI_VERSION),
    policyVersion: z.string().trim().min(1),
  })
  .strict();

export type BundledPolicyPackManifest = z.infer<typeof BundledPolicyPackManifestSchema>;

export interface BundledPolicyPackGeneration<TContribution> {
  owner: Extract<PolicyOwner, { kind: "plugin" }>;
  manifest: BundledPolicyPackManifest;
  contribution: TContribution;
}

export interface RegisterBundledPolicyPackInput<TContribution> {
  manifest: BundledPolicyPackManifest;
  artifactBytes: string | Uint8Array;
  contribution: TContribution;
}

export const BUNDLED_POLICY_PACK_MISSING_ERROR = "bundled_policy_pack_missing";
export const BUNDLED_POLICY_PACK_UNAVAILABLE_ERROR = "bundled_policy_pack_unavailable";
export const BUNDLED_POLICY_PACK_RESERVED_ID_ERROR = "bundled_policy_pack_reserved_id";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function generationKey(owner: Extract<PolicyOwner, { kind: "plugin" }>): string {
  return `${owner.pluginId}@${owner.generationDigest}`;
}

export function isBundledPolicyPluginId(pluginId: string): boolean {
  return RESERVED_BUNDLED_POLICY_PLUGIN_IDS.has(pluginId);
}

export function isValidBundledPolicyPluginId(pluginId: string): boolean {
  return PolicyPluginIdSchema.safeParse(pluginId).success;
}

export function assertLocalPluginIdAvailable(pluginId: string): void {
  if (isBundledPolicyPluginId(pluginId)) {
    throw new Error(
      `${BUNDLED_POLICY_PACK_RESERVED_ID_ERROR}: local plugin ID '${pluginId}' is reserved`,
    );
  }
}

export class BundledPolicyPackRegistry<TContribution> {
  private readonly generations = new Map<string, BundledPolicyPackGeneration<TContribution>>();
  private readonly activeOwners = new Map<string, Extract<PolicyOwner, { kind: "plugin" }>>();
  private readonly loadFailures = new Map<string, string>();
  private readonly generationLoadFailures = new Map<string, string>();

  recordLoadFailure(pluginId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.loadFailures.set(pluginId, message);
  }

  recordGenerationLoadFailure(
    ownerInput: Extract<PolicyOwner, { kind: "plugin" }>,
    error: unknown,
  ): void {
    const owner = PolicyOwnerSchema.parse(ownerInput);
    if (owner.kind !== "plugin") throw new Error("Pinned policy owner must be plugin-owned");
    const message = error instanceof Error ? error.message : String(error);
    this.generationLoadFailures.set(generationKey(owner), message);
  }

  registerGeneration(
    input: RegisterBundledPolicyPackInput<TContribution>,
  ): BundledPolicyPackGeneration<TContribution> {
    const manifest = BundledPolicyPackManifestSchema.parse(input.manifest);
    const owner = PolicyOwnerSchema.parse({
      kind: "plugin",
      pluginId: manifest.id,
      generationDigest: sha256(input.artifactBytes),
      policyVersion: manifest.policyVersion,
    });
    if (owner.kind !== "plugin") throw new Error("Bundled policy pack owner must be plugin-owned");
    const generation = { owner, manifest, contribution: input.contribution };
    const key = generationKey(owner);
    const existing = this.generations.get(key);
    const registered = existing ?? generation;
    if (!existing) this.generations.set(key, registered);
    // Clear only after parsing, owner derivation, and generation-map invariants complete.
    this.generationLoadFailures.delete(key);
    this.loadFailures.delete(manifest.id);
    return registered;
  }

  activate(owner: Extract<PolicyOwner, { kind: "plugin" }>): void {
    const generation = this.resolvePinned(owner);
    this.activeOwners.set(generation.owner.pluginId, generation.owner);
  }

  async installAndActivateCandidate(
    load: () => Promise<RegisterBundledPolicyPackInput<TContribution>>,
  ): Promise<BundledPolicyPackGeneration<TContribution>> {
    const candidate = await load();
    const generation = this.registerGeneration(candidate);
    this.activate(generation.owner);
    return generation;
  }

  resolveActive(pluginId: string): BundledPolicyPackGeneration<TContribution> {
    const owner = this.activeOwners.get(pluginId);
    if (!owner) {
      const failure = this.loadFailures.get(pluginId);
      if (failure) {
        throw new Error(`${BUNDLED_POLICY_PACK_UNAVAILABLE_ERROR}: '${pluginId}': ${failure}`);
      }
      throw new Error(
        `${BUNDLED_POLICY_PACK_MISSING_ERROR}: no active generation for '${pluginId}'`,
      );
    }
    return this.resolvePinned(owner);
  }

  listActive(): BundledPolicyPackGeneration<TContribution>[] {
    return Array.from(this.activeOwners.values(), (owner) => this.resolvePinned(owner));
  }

  resolvePinned(
    ownerInput: Extract<PolicyOwner, { kind: "plugin" }>,
  ): BundledPolicyPackGeneration<TContribution> {
    const owner = PolicyOwnerSchema.parse(ownerInput);
    if (owner.kind !== "plugin") throw new Error("Pinned policy owner must be plugin-owned");
    const key = generationKey(owner);
    const failure = this.generationLoadFailures.get(key);
    if (failure) {
      throw new Error(
        `${BUNDLED_POLICY_PACK_UNAVAILABLE_ERROR}: generation '${key}' (${owner.policyVersion}): ${failure}`,
      );
    }
    const generation = this.generations.get(key);
    if (!generation || generation.owner.policyVersion !== owner.policyVersion) {
      throw new Error(`${BUNDLED_POLICY_PACK_MISSING_ERROR}: generation '${key}' is unavailable`);
    }
    return generation;
  }
}
