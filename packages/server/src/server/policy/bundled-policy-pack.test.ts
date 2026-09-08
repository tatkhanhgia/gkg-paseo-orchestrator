import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  assertLocalPluginIdAvailable,
  BUNDLED_POLICY_PACK_MISSING_ERROR,
  BUNDLED_POLICY_PACK_RESERVED_ID_ERROR,
  BUNDLED_POLICY_PACK_UNAVAILABLE_ERROR,
  BundledPolicyPackRegistry,
} from "./bundled-policy-pack.js";
import {
  createDefaultSlpBundledPolicyRegistry,
  SLP_BUNDLED_POLICY_VERSION,
} from "./bundled/slp.js";
import { AgentManager } from "../agent/agent-manager.js";
import { createTrustedPolicyPackResolver } from "./trusted-policy.js";

const REMOVED_HISTORICAL_OWNER = {
  kind: "plugin" as const,
  pluginId: "slp" as const,
  policyVersion: "1.0.0",
  generationDigest: "569c7f4633b7ffacb2e63c0ee3dda1ea882bc050bc456fdc8ac0c466f4f483f0",
};

function manifest(policyVersion: string, id = "slp") {
  return { id, abiVersion: 1 as const, policyVersion };
}

describe("bundled policy pack registry", () => {
  test("loads the default SLP generation independently of local plugin configuration", () => {
    const first = createDefaultSlpBundledPolicyRegistry().resolveActive("slp");
    const second = createDefaultSlpBundledPolicyRegistry().resolveActive("slp");

    expect(first.owner).toEqual(second.owner);
    expect(first.owner.kind).toBe("plugin");
    expect(first.owner.policyVersion).toBe(SLP_BUNDLED_POLICY_VERSION);
    expect(first.owner.generationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.owner.generationDigest).toBe(
      "c678356acbce903191473e46d4f9a7fe575d84ebb50c72008548c0d20a5ca826",
    );
    expect(first.owner.generationDigest).not.toBe(
      "c30881a6772f1dec72f8869da6da72465fc7fa4367735052dc0f0b5f88d1b117",
    );
    expect(first.owner).toEqual(second.owner);
    expect(first.contribution.eventPolicies).toHaveLength(2);
    expect(first.contribution.eventPolicies[0]?.id).toBe("slp.attention");
    expect(first.contribution.eventPolicies[1]?.id).toBe("slp.lifecycle-attention");
    expect(first.contribution.eventPolicies[0]?.enabled({})).toBe(true);
    expect(
      first.contribution.eventPolicies[0]?.enabled({ PASEO_DISABLE_SLP_ATTENTION_POLICY: "1" }),
    ).toBe(false);
  });

  test("fails closed for a removed historical generation with no compatibility fallback", () => {
    const registry = createDefaultSlpBundledPolicyRegistry();

    expect(registry.resolveActive("slp").owner.policyVersion).toBe(SLP_BUNDLED_POLICY_VERSION);
    expect(() => registry.resolvePinned(REMOVED_HISTORICAL_OWNER)).toThrow(
      BUNDLED_POLICY_PACK_MISSING_ERROR,
    );
  });

  test("resolves the active event policy and fails closed for a removed historical owner", () => {
    const registry = createDefaultSlpBundledPolicyRegistry();
    const agents = new Map([
      ["legacy", { roleBinding: { policyOwner: { kind: "legacy-core" } } }],
      ["historical", { roleBinding: { policyOwner: REMOVED_HISTORICAL_OWNER } }],
      ["current", { roleBinding: { policyOwner: registry.resolveActive("slp").owner } }],
    ]);
    const fakeManager = {
      bundledPolicyPacks: registry,
      getAgent: (agentId: string) => agents.get(agentId) ?? null,
      getTrustedPolicyResolver: () =>
        createTrustedPolicyPackResolver({ registry, activePluginId: "slp" }),
    } as unknown as AgentManager;
    const resolve = AgentManager.prototype.resolveBundledEventPoliciesForAgent;

    expect(resolve.call(fakeManager, "legacy")).toEqual([]);
    expect(() => resolve.call(fakeManager, "historical")).toThrow(
      BUNDLED_POLICY_PACK_MISSING_ERROR,
    );
    expect(resolve.call(fakeManager, "current")).toEqual([
      expect.objectContaining({
        stateNamespace: `slp@${registry.resolveActive("slp").owner.generationDigest}`,
        policy: expect.objectContaining({ id: "slp.attention" }),
      }),
      expect.objectContaining({
        stateNamespace: `slp@${registry.resolveActive("slp").owner.generationDigest}`,
        policy: expect.objectContaining({ id: "slp.lifecycle-attention" }),
      }),
    ]);
  });

  test("reports unavailable historical role policy generations without weakening resume admission", () => {
    const registry = createDefaultSlpBundledPolicyRegistry();
    const fakeManager = {
      bundledPolicyPacks: registry,
      getTrustedPolicyResolver: () =>
        createTrustedPolicyPackResolver({ registry, activePluginId: "slp" }),
    } as unknown as AgentManager;
    const isAvailable =
      AgentManager.prototype.isStoredAgentPolicyGenerationAvailable.bind(fakeManager);
    const record = (policyOwner?: unknown) =>
      ({
        id: "historical-agent",
        provider: "codex",
        cwd: "/tmp/project",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        labels: {},
        lastStatus: "closed",
        config: null,
        ...(policyOwner ? { roleBinding: { policyOwner } } : {}),
      }) as never;

    expect(isAvailable(record())).toBe(true);
    expect(isAvailable(record({ kind: "legacy-core" }))).toBe(true);
    expect(isAvailable(record(registry.resolveActive("slp").owner))).toBe(true);
    expect(
      isAvailable(
        record({
          kind: "plugin",
          pluginId: "slp",
          policyVersion: "1.2.0",
          generationDigest: "02607618aea9fee766b468c7063ad17dc270ca7a7bba868d0ed8b436821ec172",
        }),
      ),
    ).toBe(false);
    expect(isAvailable(record(REMOVED_HISTORICAL_OWNER))).toBe(false);
  });

  test("fails closed unless an attention-question target pins an available generation", () => {
    const registry = createDefaultSlpBundledPolicyRegistry();
    const fakeManager = { bundledPolicyPacks: registry } as unknown as AgentManager;
    const assertTarget =
      AgentManager.prototype.assertAttentionQuestionTargetSupport.bind(fakeManager);
    const binding = (policyOwner: unknown) => ({ policyOwner }) as never;

    expect(() => assertTarget(binding(registry.resolveActive("slp").owner))).not.toThrow();
    expect(() => assertTarget(binding(REMOVED_HISTORICAL_OWNER))).toThrow(
      "target_generation_unavailable",
    );
    expect(() => assertTarget(binding({ kind: "legacy-core" }))).toThrow("legacy-or-non-slp");
    expect(() => assertTarget(undefined)).toThrow("target_policy_owner_missing");
    expect(() => assertTarget(binding({ kind: "plugin", pluginId: "slp" }))).toThrow(
      "target_policy_owner_invalid",
    );
    expect(() =>
      assertTarget(
        binding({
          kind: "plugin",
          pluginId: "slp",
          policyVersion: "1.2.0",
          generationDigest: "f".repeat(64),
        }),
      ),
    ).toThrow("target_generation_unavailable");
  });

  test("derives immutable ownership from exact artifact bytes", () => {
    const registry = new BundledPolicyPackRegistry<{ marker: string }>();
    const generation = registry.registerGeneration({
      manifest: manifest("1.0.0"),
      artifactBytes: "exact bundled SLP bytes",
      contribution: { marker: "v1" },
    });

    expect(generation.owner).toEqual({
      kind: "plugin",
      pluginId: "slp",
      generationDigest: createHash("sha256").update("exact bundled SLP bytes").digest("hex"),
      policyVersion: "1.0.0",
    });
  });

  test("accepts a trusted non-SLP generation without changing the pinned owner shape", () => {
    const registry = new BundledPolicyPackRegistry<{ marker: string }>();
    const generation = registry.registerGeneration({
      manifest: manifest("0.1.0", "fixture-policy"),
      artifactBytes: "exact non-SLP fixture bytes",
      contribution: { marker: "fixture" },
    });
    registry.activate(generation.owner);

    expect(registry.resolveActive("fixture-policy")).toEqual(generation);
    expect(generation.owner).toMatchObject({
      kind: "plugin",
      pluginId: "fixture-policy",
      policyVersion: "0.1.0",
    });
    expect(() => registry.resolveActive("slp")).toThrow(BUNDLED_POLICY_PACK_MISSING_ERROR);
  });

  test("pins old agents while a newer generation becomes active", async () => {
    const registry = new BundledPolicyPackRegistry<{ marker: string }>();
    const first = await registry.installAndActivateCandidate(async () => ({
      manifest: manifest("1.0.0"),
      artifactBytes: "generation one",
      contribution: { marker: "v1" },
    }));
    const second = await registry.installAndActivateCandidate(async () => ({
      manifest: manifest("2.0.0"),
      artifactBytes: "generation two",
      contribution: { marker: "v2" },
    }));

    expect(registry.resolveActive("slp").owner).toEqual(second.owner);
    expect(registry.resolvePinned(first.owner).contribution.marker).toBe("v1");
    expect(registry.resolvePinned(second.owner).contribution.marker).toBe("v2");
  });

  test("keeps the active generation when a candidate fails to load", async () => {
    const registry = new BundledPolicyPackRegistry<{ marker: string }>();
    const first = await registry.installAndActivateCandidate(async () => ({
      manifest: manifest("1.0.0"),
      artifactBytes: "stable generation",
      contribution: { marker: "stable" },
    }));

    await expect(
      registry.installAndActivateCandidate(async () => {
        throw new Error("candidate failed validation");
      }),
    ).rejects.toThrow("candidate failed validation");
    expect(registry.resolveActive("slp").owner).toEqual(first.owner);
  });

  test("fails closed for missing generations and reserves the SLP local-plugin ID", () => {
    const registry = new BundledPolicyPackRegistry<unknown>();
    expect(() => registry.resolveActive("slp")).toThrow(BUNDLED_POLICY_PACK_MISSING_ERROR);
    expect(() =>
      registry.resolvePinned({
        kind: "plugin",
        pluginId: "slp",
        generationDigest: "a".repeat(64),
        policyVersion: "1.0.0",
      }),
    ).toThrow(BUNDLED_POLICY_PACK_MISSING_ERROR);
    expect(() => assertLocalPluginIdAvailable("slp")).toThrow(
      BUNDLED_POLICY_PACK_RESERVED_ID_ERROR,
    );
    expect(() => assertLocalPluginIdAvailable("my-local-plugin")).not.toThrow();
  });

  test("preserves a bundled load failure without falling back to legacy core", () => {
    const registry = new BundledPolicyPackRegistry<unknown>();
    registry.recordLoadFailure("slp", new Error("invalid bundled artifact"));

    expect(() => registry.resolveActive("slp")).toThrow(BUNDLED_POLICY_PACK_UNAVAILABLE_ERROR);
    expect(() => registry.resolveActive("slp")).toThrow("invalid bundled artifact");
  });
});
