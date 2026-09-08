import { describe, expect, test } from "vitest";

import {
  buildCouncilKickoffBody,
  DEFAULT_COUNCIL_TIER,
  resolveCouncilTierAndRoles,
  validateCouncilSeatRoles,
} from "./council-policy.js";

describe("bundled SLP Council tier/seat policy resolver", () => {
  test("defaults to debate with Architect+Reviewer when both tier and roles are omitted", () => {
    expect(resolveCouncilTierAndRoles({})).toEqual({
      tier: "debate",
      roles: ["architect", "reviewer"],
    });
    expect(DEFAULT_COUNCIL_TIER).toBe("debate");
  });

  test("roles-only compatibility: a supplied single Scout keeps the historical implicit debate-with-proof tier", () => {
    expect(resolveCouncilTierAndRoles({ roles: ["scout"] })).toEqual({
      tier: "debate-with-proof",
      roles: ["scout"],
    });
  });

  test("roles-only compatibility: the old explicit Scout+Architect+Reviewer triple is preserved, not discarded", () => {
    expect(resolveCouncilTierAndRoles({ roles: ["scout", "architect", "reviewer"] })).toEqual({
      tier: "debate-with-proof",
      roles: ["scout", "architect", "reviewer"],
    });
  });

  test("resolves skill-appropriate default seats for an explicit tier with omitted roles", () => {
    expect(resolveCouncilTierAndRoles({ tier: "debate" })).toEqual({
      tier: "debate",
      roles: ["architect", "reviewer"],
    });
    expect(resolveCouncilTierAndRoles({ tier: "debate-with-proof" })).toEqual({
      tier: "debate-with-proof",
      roles: ["scout", "architect", "reviewer"],
    });
    expect(resolveCouncilTierAndRoles({ tier: "high-risk" })).toEqual({
      tier: "high-risk",
      roles: ["scout", "architect", "reviewer"],
    });
  });

  test("lens with omitted roles resolves the policy-owned smallest framing default of one Architect", () => {
    expect(resolveCouncilTierAndRoles({ tier: "lens" })).toEqual({
      tier: "lens",
      roles: ["architect"],
    });
  });

  test("lens enforces exactly one seat even when explicit roles stay within the allowed set", () => {
    expect(() =>
      resolveCouncilTierAndRoles({ tier: "lens", roles: ["architect", "reviewer"] }),
    ).toThrow("seats exactly one role");
  });

  test("an explicit empty role list is invalid and distinct from omission", () => {
    expect(() => resolveCouncilTierAndRoles({ tier: "lens", roles: [] })).toThrow(
      "requires at least one explicit seat role",
    );
    expect(() => resolveCouncilTierAndRoles({ tier: "debate", roles: [] })).toThrow(
      "requires at least one explicit seat role",
    );
  });

  test("accepts explicit roles that stay within the resolved tier's canonical seats", () => {
    expect(resolveCouncilTierAndRoles({ tier: "lens", roles: ["architect"] })).toEqual({
      tier: "lens",
      roles: ["architect"],
    });
    expect(resolveCouncilTierAndRoles({ tier: "lens", roles: ["reviewer"] })).toEqual({
      tier: "lens",
      roles: ["reviewer"],
    });
    expect(
      resolveCouncilTierAndRoles({ tier: "debate", roles: ["architect", "reviewer"] }),
    ).toEqual({ tier: "debate", roles: ["architect", "reviewer"] });
    expect(
      resolveCouncilTierAndRoles({
        tier: "debate-with-proof",
        roles: ["scout", "architect", "reviewer"],
      }),
    ).toEqual({ tier: "debate-with-proof", roles: ["scout", "architect", "reviewer"] });
  });

  test("preserves explicit single/partial seat inputs for compatibility, not verdict sufficiency", () => {
    expect(resolveCouncilTierAndRoles({ tier: "debate", roles: ["reviewer"] })).toEqual({
      tier: "debate",
      roles: ["reviewer"],
    });
    expect(
      resolveCouncilTierAndRoles({ tier: "debate-with-proof", roles: ["architect", "reviewer"] }),
    ).toEqual({ tier: "debate-with-proof", roles: ["architect", "reviewer"] });
  });

  test("labels the runtime limit without turning partial input parsing into an acceptance gate", () => {
    const body = buildCouncilKickoffBody({
      caseId: "case-1",
      title: "Bounded review",
      question: "Is the change safe?",
      tier: "debate",
      roles: ["reviewer"],
    });
    expect(body).toContain("Starting seats preserve compatibility only");
    expect(body).toContain("debate normal verdict requires Architect+Reviewer handbacks");
    expect(body).toContain("Missing returned handbacks are DEGRADED");
  });

  test("rejects a seat role that does not belong to the resolved tier, with a clear reason", () => {
    expect(() => resolveCouncilTierAndRoles({ tier: "lens", roles: ["scout"] })).toThrow(
      "Council tier 'lens' does not use seat role 'scout'",
    );
    expect(() =>
      resolveCouncilTierAndRoles({ tier: "debate", roles: ["scout", "architect"] }),
    ).toThrow("Council tier 'debate' does not use seat role 'scout'");
  });

  test("still enforces uniqueness for explicit roles via the shared validator", () => {
    expect(() =>
      resolveCouncilTierAndRoles({ tier: "debate", roles: ["architect", "architect"] }),
    ).toThrow("must be unique");
    expect(() => validateCouncilSeatRoles(["reviewer", "reviewer"])).toThrow("must be unique");
  });
});
