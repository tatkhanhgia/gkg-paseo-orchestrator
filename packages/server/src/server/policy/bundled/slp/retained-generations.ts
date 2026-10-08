import { createHash } from "node:crypto";

import type { BundledPolicyPackRegistry } from "../../bundled-policy-pack.js";
import type { SlpBundledPolicyContribution } from "../slp.js";
import type { RoleBindingPolicyContribution } from "../../role-binding-policy.js";

/**
 * A prior generation the registry keeps resolvable (never active) so role bindings that release
 * created still resume. Each one is current source minus what entered the canonical SLP artifact
 * after it shipped; `withRoleInstructionMandates` says whether the mandate table was already there.
 */
export interface RetainedSlpGeneration {
  /** Owner digest recorded on every role binding that release created. */
  generationDigest: string;
  release: string;
  /** Short drift code recorded when current source no longer reproduces this owner. */
  driftCode: string;
  withRoleInstructionMandates: boolean;
}

/**
 * Both generations predate the Lead Council trigger (Foundation 0.1.0-dev.25-gkg.1), so both
 * recompute from role definitions without that block.
 *
 * COMPAT(slpPreCouncilTriggerGeneration): the 0.8.0-paseo.4 entry was added after
 * v0.8.0-paseo.4, remove after 2027-03-31 or once no stored agent resolves this owner, whichever
 * comes first.
 *
 * COMPAT(slpPreMandateGeneration): the 0.8.0-paseo.2 entry was added after v0.8.0-paseo.2, remove
 * after 2027-03-31 or once no stored agent resolves this owner, whichever comes first.
 */
export const RETAINED_SLP_GENERATIONS: readonly RetainedSlpGeneration[] = [
  {
    generationDigest: "1aedb08557a78cf64b4826b91a20aa33dde61131ff431350a847fde4c0482c49",
    release: "0.8.0-paseo.4",
    driftCode: "retained_slp_generation_pre_council_trigger_drift",
    withRoleInstructionMandates: true,
  },
  {
    generationDigest: "7a9e09536c571e0d94bd7455926373da351f2c66ed3295342da542c82075fb01",
    release: "0.8.0-paseo.2",
    driftCode: "retained_slp_generation_pre_mandate_drift",
    withRoleInstructionMandates: false,
  },
];

/**
 * Registers (never activates) one retained generation. Its contribution composes with the same
 * role definitions and mandate table its artifact bytes were derived from, so the identity keeps
 * exactly its original composition semantics; resumed agents replay their persisted instruction
 * bytes either way.
 *
 * Admission is byte-verified: the derived artifact must hash to the recorded digest. Any other
 * change to roles, execution profiles, tool ceilings, or skill/harness descriptors breaks that
 * equality and fails this one owner closed rather than serving drifted data under the old
 * identity. Like the active generation, function-body-only edits in reused policy modules are
 * outside this data check.
 */
export function registerRetainedSlpGeneration(
  registry: BundledPolicyPackRegistry<SlpBundledPolicyContribution>,
  input: {
    policyVersion: string;
    retained: RetainedSlpGeneration;
    buildArtifactBytes: () => string;
    buildRoleBindingPolicy: () => RoleBindingPolicyContribution<string>;
    buildContribution: (
      roleBindingPolicy: RoleBindingPolicyContribution<string>,
    ) => SlpBundledPolicyContribution;
  },
): void {
  const { retained } = input;
  const owner = {
    kind: "plugin" as const,
    pluginId: "slp" as const,
    generationDigest: retained.generationDigest,
    policyVersion: input.policyVersion,
  };
  try {
    const artifactBytes = input.buildArtifactBytes();
    const computedDigest = createHash("sha256").update(artifactBytes).digest("hex");
    if (computedDigest !== retained.generationDigest) {
      throw new Error(
        `${retained.driftCode}: derived source hashes to ${computedDigest}, not the recorded ${retained.release} owner ${retained.generationDigest}`,
      );
    }
    registry.registerGeneration({
      manifest: { id: "slp", abiVersion: 1, policyVersion: input.policyVersion },
      artifactBytes,
      contribution: input.buildContribution(input.buildRoleBindingPolicy()),
    });
  } catch (error) {
    registry.recordGenerationLoadFailure(owner, error);
  }
}
