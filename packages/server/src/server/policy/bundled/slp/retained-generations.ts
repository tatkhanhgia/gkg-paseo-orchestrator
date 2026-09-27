import { createHash } from "node:crypto";

import type { BundledPolicyPackRegistry } from "../../bundled-policy-pack.js";
import type { SlpBundledPolicyContribution } from "../slp.js";
import {
  RETAINED_SLP_COORDINATION_POLICY_V5,
  RETAINED_SLP_COORDINATION_POLICY_VERSION_V5,
} from "./retained-coordination-policy-v5.js";
import {
  RETAINED_SLP_ARTIFACT_BYTES_V60,
  RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256,
} from "./retained-slp-artifact-v60.js";
import {
  computeRetainedHookFidelity,
  type RetainedHookFidelityCheckResult,
} from "./retained-hook-fidelity-guard.js";
import { createSlpRoleBindingPolicy } from "./role-binding-policy.js";
import type { RoleBindingPolicyContribution } from "../../role-binding-policy.js";

/**
 * Registers exactly one immediately-preceding qualified SLP generation (release 0.7.0-paseo.60,
 * owner `plugin:slp@d19918d9…0770c`) so `resolvePinned` can restore it for an agent that was
 * bound before the .61 upgrade. This never calls `registry.activate(...)`: new launches always
 * resolve the current generation registered by `populateSlpBundledPolicyRegistry` in slp.ts.
 *
 * Scope discipline (see docs/slp-bundled-policy-pack-audit.md F-04 for the anti-pattern this
 * deliberately avoids): exactly one dated, tagged, byte-verified prior generation — not an
 * open-ended historical chain, and not a resurrection of the deleted v1.0 (.45) generation.
 * Remove this module and its two frozen fixtures once no archived/live agent still resolves
 * this owner.
 */
export function registerRetainedSlpGenerations(
  registry: BundledPolicyPackRegistry<SlpBundledPolicyContribution>,
  input: {
    policyVersion: string;
    buildDefaultContribution: () => SlpBundledPolicyContribution;
    /**
     * Recomputes the canonical artifact bytes from *current* source with only
     * coordinationPolicyVersion swapped to the given historical value. Must equal
     * RETAINED_SLP_ARTIFACT_BYTES_V60 today (proven at the 0.7.0-paseo.62 candidate: only
     * coordination-policy.js/.d.ts differ between the real .60 and .61 installed dist trees;
     * every other file is byte-identical). If a later source change ever breaks that equality,
     * this is the guard that catches it and fails the retained owner closed instead of quietly
     * reusing current (drifted) non-coordination contribution pieces under the old .60 identity.
     */
    buildArtifactBytesForCoordinationVersion: (coordinationPolicyVersion: string) => string;
    /**
     * Static byte-fingerprint check for the reused hook IMPLEMENTATION modules (council-policy,
     * checkpoint-policy, execution-profiles, role-binding-policy) that the descriptor-bytes check
     * above cannot see (see retained-hook-fidelity-guard.ts). Defaults to the real guard reading
     * the real checked-out source tree; overridable only so tests can inject a synthetic result
     * without touching real source files.
     */
    checkHookFidelity?: () => RetainedHookFidelityCheckResult;
  },
): void {
  const owner = {
    kind: "plugin" as const,
    pluginId: "slp" as const,
    generationDigest: RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256,
    policyVersion: input.policyVersion,
  };
  try {
    const computedDigest = createHash("sha256")
      .update(RETAINED_SLP_ARTIFACT_BYTES_V60)
      .digest("hex");
    if (computedDigest !== RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256) {
      throw new Error(
        `retained_slp_generation_bytes_drift: frozen .60 artifact fixture no longer hashes to the recorded owner digest (expected ${RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256}, computed ${computedDigest})`,
      );
    }
    const liveEquivalentBytes = input.buildArtifactBytesForCoordinationVersion(
      RETAINED_SLP_COORDINATION_POLICY_VERSION_V5,
    );
    if (liveEquivalentBytes !== RETAINED_SLP_ARTIFACT_BYTES_V60) {
      throw new Error(
        "retained_slp_generation_non_coordination_drift: current source no longer reproduces the frozen .60 artifact outside coordinationPolicyVersion (roles/execution-profiles/tool-ceilings/skill/harness descriptors have changed); this retained generation's reused-live contribution pieces would no longer match the pinned .60 identity, so it is refused rather than served drifted",
      );
    }
    // canonicalSlpArtifactBytes() above is a JSON.stringify of DATA only — it silently drops
    // function VALUES, so a function-body-only change to council-policy/checkpoint-policy/
    // execution-profiles/role-binding-policy that leaves every version string unchanged would be
    // invisible to the check above. This static byte fingerprint closes that named gap; see
    // retained-hook-fidelity-guard.ts for exact bounded coverage and residual-gap disclosure.
    const hookFidelity = (input.checkHookFidelity ?? computeRetainedHookFidelity)();
    if (!hookFidelity.ok) {
      throw new Error(
        `retained_slp_generation_hook_module_drift: ${hookFidelity.failures.join("; ")}`,
      );
    }
    registry.registerGeneration({
      manifest: {
        id: "slp",
        abiVersion: 1,
        policyVersion: input.policyVersion,
      },
      artifactBytes: RETAINED_SLP_ARTIFACT_BYTES_V60,
      contribution: {
        ...input.buildDefaultContribution(),
        coordinationPolicy: RETAINED_SLP_COORDINATION_POLICY_V5,
      },
    });
  } catch (error) {
    registry.recordGenerationLoadFailure(owner, error);
  }
}

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
 * mandate upgrade keep resolving their pinned owner. The retained contribution composes with an
 * empty mandate table, so this identity keeps exactly its original composition semantics; resumed
 * agents replay their persisted instruction bytes either way.
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
      contribution: input.buildContribution(createSlpRoleBindingPolicy({})),
    });
  } catch (error) {
    registry.recordGenerationLoadFailure(owner, error);
  }
}
