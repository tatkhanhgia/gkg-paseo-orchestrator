import { describe, expect, test } from "vitest";

import {
  isProviderRoleBindingSupportedForRole,
  PASEO_ROLE_CONTRACT_VERSION,
  PASEO_ROLE_IDS,
  ProviderRoleBindingSupportSchema,
  RoleBindingReceiptSchema,
} from "./role-binding.js";

describe("Paseo role binding protocol", () => {
  test("publishes the three Foundation roles under one contract version", () => {
    expect(PASEO_ROLE_IDS).toEqual(["lead", "peer", "supervisor"]);
    expect(PASEO_ROLE_CONTRACT_VERSION).toBe("3.2.0-topology-recovery");
  });

  test("keeps supported and unsupported provider capability explicit", () => {
    expect(
      ProviderRoleBindingSupportSchema.parse({
        status: "supported",
        injectionMethod: "codex-developer-instructions",
      }),
    ).toEqual({
      status: "supported",
      injectionMethod: "codex-developer-instructions",
    });
    expect(
      ProviderRoleBindingSupportSchema.parse({
        status: "supported",
        injectionMethod: "mock-launch-context",
      }),
    ).toEqual({
      status: "supported",
      injectionMethod: "mock-launch-context",
    });
    expect(
      ProviderRoleBindingSupportSchema.parse({
        status: "supported",
        injectionMethod: "grok-acp-session-rules",
      }),
    ).toEqual({
      status: "supported",
      injectionMethod: "grok-acp-session-rules",
    });
    expect(() => ProviderRoleBindingSupportSchema.parse({ status: "unsupported" })).toThrow();
    expect(() =>
      ProviderRoleBindingSupportSchema.parse({
        status: "candidate",
        injectionMethod: "cursor-always-apply-plugin",
        reason: "runtime canary required",
      }),
    ).toThrow();

    const peerOnly = ProviderRoleBindingSupportSchema.parse({
      status: "supported",
      injectionMethod: "antigravity-custom-agent",
      roleIds: ["peer"],
    });
    expect(isProviderRoleBindingSupportedForRole(peerOnly, "peer")).toBe(true);
    expect(isProviderRoleBindingSupportedForRole(peerOnly, "lead")).toBe(false);
    expect(isProviderRoleBindingSupportedForRole(peerOnly, "supervisor")).toBe(false);

    const unavailablePeerOnly = ProviderRoleBindingSupportSchema.parse({
      status: "unsupported",
      reason: "transport unavailable",
      roleIds: ["peer"],
    });
    expect(unavailablePeerOnly.roleIds).toEqual(["peer"]);
    expect(isProviderRoleBindingSupportedForRole(unavailablePeerOnly, "peer")).toBe(false);
  });

  test("role receipts contain no materialized instruction bytes", () => {
    const receipt = RoleBindingReceiptSchema.parse({
      roleId: "lead",
      definitionVersion: PASEO_ROLE_CONTRACT_VERSION,
      definitionDigest: "a".repeat(64),
      bindingDigest: "c".repeat(64),
      provider: "codex",
      injectionMethod: "codex-developer-instructions",
      qualification: "implementation-supported",
      workspaceProtocol: {
        status: "bound",
        readership: "full",
        path: "/repo/WORKSPACE_PROTOCOL.md",
        digest: "b".repeat(64),
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      instructions: "must be stripped",
    });

    expect(receipt).not.toHaveProperty("instructions");
  });
});
