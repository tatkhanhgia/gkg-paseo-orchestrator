import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { BUNDLED_POLICY_PACK_MISSING_ERROR } from "./bundled-policy-pack.js";
import {
  buildCanonicalSlpArtifactBytesForCoordinationVersion,
  createDefaultSlpBundledPolicyRegistry,
  SLP_BUNDLED_POLICY_VERSION,
} from "./bundled/slp.js";
import { createTrustedPolicyPackResolver } from "./trusted-policy.js";

/**
 * Reproduces the Root-observed SEND_FAILED bundled_policy_pack_missing regression: resuming an
 * agent bound to release 0.7.0-paseo.60's SLP generation
 * (`plugin:slp@d19918d93ff78dab8a89652a82e5647a86e1503cad752f4aa6a256ab3f30770c`) against a
 * freshly-started .61 daemon process.
 *
 * This exercises the exact seam `AgentManager.resolveSlpPolicyForRoleBinding` and
 * `AgentManager#assertCurrentRoleAdmission` use in production
 * (packages/server/src/server/agent/agent-manager.ts:1561, :5987):
 * `resolveTrustedPolicyResolver` wraps `createDefaultSlpBundledPolicyRegistry()` /
 * `createFailClosedSlpBundledPolicyRegistry()` with `createTrustedPolicyPackResolver`, and both
 * call sites resolve through `.resolvePinned(owner)` on that resolver — not a bare
 * `BundledPolicyPackRegistry` unit constructed by the test. Building the registry+resolver the
 * same way production does is what proves the restore actually reaches that seam.
 */

const RETAINED_V60_OWNER = {
  kind: "plugin" as const,
  pluginId: "slp" as const,
  generationDigest: "d19918d93ff78dab8a89652a82e5647a86e1503cad752f4aa6a256ab3f30770c",
  policyVersion: "1.4.0",
};

function buildProductionResolver() {
  const registry = createDefaultSlpBundledPolicyRegistry();
  return { registry, resolver: createTrustedPolicyPackResolver({ registry }) };
}

describe("SLP generation resume across .60 -> .61", () => {
  test("current source, with coordinationPolicyVersion swapped to 5, still reproduces the exact frozen .60 owner digest today", () => {
    // This is the live drift guard's happy-path proof: if a future source change (role
    // definitions, execution profiles, tool ceilings, skill/harness descriptors) ever breaks
    // this equality, registerRetainedSlpGenerations fails the retained .60 owner closed instead
    // of silently serving drifted current-source behavior under the old identity.
    const liveEquivalentBytes = buildCanonicalSlpArtifactBytesForCoordinationVersion("5");
    const digest = createHash("sha256").update(liveEquivalentBytes).digest("hex");

    expect(digest).toBe(RETAINED_V60_OWNER.generationDigest);
  });

  test("resolves the known-qualified .60 owner through the registry seam", () => {
    const { resolver } = buildProductionResolver();

    const generation = resolver.resolvePinned(RETAINED_V60_OWNER);

    expect(generation.owner).toEqual(RETAINED_V60_OWNER);
  });

  test("current .61 generation remains active and resolves independently of the retained one", () => {
    const { resolver } = buildProductionResolver();

    const active = resolver.resolveActiveRolePolicy();

    expect(active.owner.pluginId).toBe("slp");
    expect(active.owner.policyVersion).toBe(SLP_BUNDLED_POLICY_VERSION);
    expect(active.owner.generationDigest).not.toBe(RETAINED_V60_OWNER.generationDigest);
    expect(resolver.resolvePinned(active.owner).owner).toEqual(active.owner);
  });

  test("only the current generation is active for new launches", () => {
    const { resolver } = buildProductionResolver();

    const activeGenerations = resolver.listActive();

    expect(activeGenerations).toHaveLength(1);
    expect(activeGenerations[0]?.owner.generationDigest).not.toBe(
      RETAINED_V60_OWNER.generationDigest,
    );
  });

  test("an unknown generation digest fails closed through the same seam", () => {
    const { resolver } = buildProductionResolver();

    expect(() =>
      resolver.resolvePinned({
        kind: "plugin",
        pluginId: "slp",
        generationDigest: "0".repeat(64),
        policyVersion: "1.4.0",
      }),
    ).toThrow(BUNDLED_POLICY_PACK_MISSING_ERROR);
  });

  test("a tampered receipt claiming the .60 digest under a mismatched policyVersion fails closed", () => {
    const { resolver } = buildProductionResolver();

    expect(() => resolver.resolvePinned({ ...RETAINED_V60_OWNER, policyVersion: "9.9.9" })).toThrow(
      BUNDLED_POLICY_PACK_MISSING_ERROR,
    );
  });

  test("the restored .60 generation enforces the old coordination-policy guard, not the current one", () => {
    const { resolver } = buildProductionResolver();
    const retained = resolver.resolvePinned(RETAINED_V60_OWNER);
    const active = resolver.resolveActiveRolePolicy();

    // "5" rejected a bare past-tense mention of an effect verb anywhere in the observation
    // ("deleted three records yesterday"); "6" narrowed this to only reject modal/performative
    // framing, deliberately allowing plain factual past-tense reports. Same input, same
    // assertion call, on the two different pinned generations.
    const input = {
      targetAgentId: "agent-1",
      targetRoleId: "lead" as const,
      callerRoleId: "supervisor" as const,
      callerAgentId: "sup-1",
      callerWorkspaceId: "ws-1",
      targetWorkspaceId: "ws-1",
      observation: "The migration deleted three records yesterday.",
      question: "What confirms this row count?",
      evidenceRefs: ["ref-1"],
    };

    expect(() =>
      retained.contribution.coordinationPolicy.assertAttentionQuestionAuthority(input),
    ).toThrow("attention_question observation must be authority-neutral factual prose");
    expect(() =>
      active.contribution.coordinationPolicy.assertAttentionQuestionAuthority(input),
    ).not.toThrow();
  });

  test("everything but coordinationPolicy is shared identically between the retained and active generation contributions", () => {
    const { resolver } = buildProductionResolver();
    const retained = resolver.resolvePinned(RETAINED_V60_OWNER);
    const active = resolver.resolveActiveRolePolicy();

    expect(retained.contribution.coordinationPolicy).not.toBe(
      active.contribution.coordinationPolicy,
    );
    expect(retained.contribution.roleBindingPolicy).toBe(active.contribution.roleBindingPolicy);
    expect(retained.contribution.councilPolicy).toBe(active.contribution.councilPolicy);
    expect(retained.contribution.checkpointPolicy).toBe(active.contribution.checkpointPolicy);
    expect(retained.contribution.executionProfilePolicy).toBe(
      active.contribution.executionProfilePolicy,
    );
  });
});
