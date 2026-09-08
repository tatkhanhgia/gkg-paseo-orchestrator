import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { BundledPolicyPackRegistry } from "../../bundled-policy-pack.js";
import type { SlpBundledPolicyContribution } from "../slp.js";
import { RETAINED_SLP_COORDINATION_POLICY_V5 } from "./retained-coordination-policy-v5.js";
import {
  RETAINED_SLP_ARTIFACT_BYTES_V60,
  RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256,
} from "./retained-slp-artifact-v60.js";
import { registerRetainedSlpGenerations } from "./retained-generations.js";

const V60_OWNER = {
  kind: "plugin" as const,
  pluginId: "slp" as const,
  generationDigest: RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256,
  policyVersion: "1.4.0",
};

function stubContribution(): SlpBundledPolicyContribution {
  return {
    roleBindingPolicy: {} as SlpBundledPolicyContribution["roleBindingPolicy"],
    councilPolicy: {} as SlpBundledPolicyContribution["councilPolicy"],
    coordinationPolicy: {} as SlpBundledPolicyContribution["coordinationPolicy"],
    checkpointPolicy: {} as SlpBundledPolicyContribution["checkpointPolicy"],
    eventPolicies: [],
    executionProfilePolicy: {} as SlpBundledPolicyContribution["executionProfilePolicy"],
    buildRoleProfileCatalog:
      (() => ({})) as SlpBundledPolicyContribution["buildRoleProfileCatalog"],
    workspaceProtocolReadership: () => "assignment-only",
    preflightRoleBinding: (() => ({})) as SlpBundledPolicyContribution["preflightRoleBinding"],
    materializeRoleBinding: (() =>
      Promise.resolve({})) as SlpBundledPolicyContribution["materializeRoleBinding"],
  };
}

describe("retained SLP generation fixture", () => {
  test("the frozen .60 artifact bytes hash to exactly the reported missing owner digest", () => {
    expect(createHash("sha256").update(RETAINED_SLP_ARTIFACT_BYTES_V60).digest("hex")).toBe(
      "d19918d93ff78dab8a89652a82e5647a86e1503cad752f4aa6a256ab3f30770c",
    );
    expect(RETAINED_SLP_ARTIFACT_BYTES_V60_SHA256).toBe(
      "d19918d93ff78dab8a89652a82e5647a86e1503cad752f4aa6a256ab3f30770c",
    );
  });
});

// Matches the real source-drift guard's happy path: current source, with only
// coordinationPolicyVersion swapped to "5", must still reproduce the frozen .60 bytes exactly.
const matchingArtifactBytesBuilder = () => RETAINED_SLP_ARTIFACT_BYTES_V60;

describe("registerRetainedSlpGenerations", () => {
  test("registers the retained generation without activating it", () => {
    const registry = new BundledPolicyPackRegistry<SlpBundledPolicyContribution>();
    registerRetainedSlpGenerations(registry, {
      policyVersion: "1.4.0",
      buildDefaultContribution: stubContribution,
      buildArtifactBytesForCoordinationVersion: matchingArtifactBytesBuilder,
    });

    expect(registry.resolvePinned(V60_OWNER).owner).toEqual(V60_OWNER);
    expect(() => registry.resolveActive("slp")).toThrow("bundled_policy_pack_missing");
  });

  test("swaps in the frozen v5 coordination policy and keeps everything else from the default contribution", () => {
    const registry = new BundledPolicyPackRegistry<SlpBundledPolicyContribution>();
    const marker = {
      marker: "default-contribution",
    } as unknown as SlpBundledPolicyContribution["councilPolicy"];
    registerRetainedSlpGenerations(registry, {
      policyVersion: "1.4.0",
      buildDefaultContribution: () => ({ ...stubContribution(), councilPolicy: marker }),
      buildArtifactBytesForCoordinationVersion: matchingArtifactBytesBuilder,
    });

    const generation = registry.resolvePinned(V60_OWNER);
    expect(generation.contribution.coordinationPolicy).toBe(RETAINED_SLP_COORDINATION_POLICY_V5);
    expect(generation.contribution.councilPolicy).toBe(marker);
  });

  test("never throws even if the default-contribution builder itself throws", () => {
    const registry = new BundledPolicyPackRegistry<SlpBundledPolicyContribution>();

    expect(() =>
      registerRetainedSlpGenerations(registry, {
        policyVersion: "1.4.0",
        buildDefaultContribution: () => {
          throw new Error("simulated contribution build failure");
        },
        buildArtifactBytesForCoordinationVersion: matchingArtifactBytesBuilder,
      }),
    ).not.toThrow();
    expect(() => registry.resolvePinned(V60_OWNER)).toThrow("bundled_policy_pack_unavailable");
  });

  test("fails the retained owner closed, without throwing, when current non-coordination source has drifted from the frozen .60 bytes", () => {
    const registry = new BundledPolicyPackRegistry<SlpBundledPolicyContribution>();

    expect(() =>
      registerRetainedSlpGenerations(registry, {
        policyVersion: "1.4.0",
        buildDefaultContribution: stubContribution,
        // Simulates a future source change (e.g. role-definitions content) that the retained
        // generation's reused-live contribution pieces would silently follow.
        buildArtifactBytesForCoordinationVersion: () => "drifted current-source bytes",
      }),
    ).not.toThrow();
    expect(() => registry.resolvePinned(V60_OWNER)).toThrow("bundled_policy_pack_unavailable");
    expect(() => registry.resolvePinned(V60_OWNER)).toThrow(
      "retained_slp_generation_non_coordination_drift",
    );
  });

  test("passes the exact retained coordination-policy version to the drift-guard builder", () => {
    const registry = new BundledPolicyPackRegistry<SlpBundledPolicyContribution>();
    let receivedVersion: string | undefined;

    registerRetainedSlpGenerations(registry, {
      policyVersion: "1.4.0",
      buildDefaultContribution: stubContribution,
      buildArtifactBytesForCoordinationVersion: (coordinationPolicyVersion) => {
        receivedVersion = coordinationPolicyVersion;
        return RETAINED_SLP_ARTIFACT_BYTES_V60;
      },
    });

    expect(receivedVersion).toBe("5");
  });
});
