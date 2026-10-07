import { createHash } from "node:crypto";

import type { BundledPolicyPackRegistry } from "../../bundled-policy-pack.js";
import type { SlpBundledPolicyContribution } from "../slp.js";
import { SLP_ROLE_BINDING_POLICY } from "./role-binding-policy.js";
import type { RoleBindingPolicyContribution } from "../../role-binding-policy.js";

/**
 * Generation that shipped in release 0.8.0-paseo.2, before the role instruction mandate table
 * (the `test-value` mandate for Lead and Peer) entered the canonical SLP artifact. Its digest is
 * the owner recorded on every role binding that release created.
 */
export const RETAINED_PRE_MANDATE_SLP_GENERATION_DIGEST =
  "7a9e09536c571e0d94bd7455926373da351f2c66ed3295342da542c82075fb01";

/**
 * COMPAT(slpPreMandateGeneration): added after v0.8.0-paseo.2, remove after 2027-03-31 or once no
 * stored agent resolves this owner, whichever comes first.
 *
 * Registers (never activates) the 0.8.0-paseo.2 generation so Leads and Peers bound before the
 * mandate upgrade keep resolving their pinned owner. The retained contribution uses the unwrapped
 * role-binding policy (no mandate table), so this identity keeps exactly its original composition
 * semantics; resumed agents replay their persisted instruction bytes either way.
 *
 * Admission is byte-verified: current source with the mandate table removed must hash to the
 * recorded digest. Any later change to roles, execution profiles, tool ceilings, or skill/harness
 * descriptors breaks that equality and fails this one owner closed rather than serving drifted
 * data under the old identity. Like the active generation, function-body-only edits in reused
 * policy modules are outside this data check.
 */
export function registerRetainedPreMandateSlpGeneration(
  registry: BundledPolicyPackRegistry<SlpBundledPolicyContribution>,
  input: {
    policyVersion: string;
    buildArtifactBytes: () => string;
    buildContribution: (
      roleBindingPolicy: RoleBindingPolicyContribution<string>,
    ) => SlpBundledPolicyContribution;
  },
): void {
  const owner = {
    kind: "plugin" as const,
    pluginId: "slp" as const,
    generationDigest: RETAINED_PRE_MANDATE_SLP_GENERATION_DIGEST,
    policyVersion: input.policyVersion,
  };
  try {
    const artifactBytes = input.buildArtifactBytes();
    const computedDigest = createHash("sha256").update(artifactBytes).digest("hex");
    if (computedDigest !== RETAINED_PRE_MANDATE_SLP_GENERATION_DIGEST) {
      throw new Error(
        `retained_slp_generation_pre_mandate_drift: current source without the role mandate table hashes to ${computedDigest}, not the recorded 0.8.0-paseo.2 owner ${RETAINED_PRE_MANDATE_SLP_GENERATION_DIGEST}`,
      );
    }
    registry.registerGeneration({
      manifest: { id: "slp", abiVersion: 1, policyVersion: input.policyVersion },
      artifactBytes,
      contribution: input.buildContribution(SLP_ROLE_BINDING_POLICY),
    });
  } catch (error) {
    registry.recordGenerationLoadFailure(owner, error);
  }
}
