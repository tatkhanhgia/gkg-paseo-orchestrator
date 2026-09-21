import { describe, expect, test } from "vitest";

import { MutableDaemonConfigPatchSchema, MutableDaemonConfigSchema } from "./messages.js";
import {
  ProviderOverrideSchema,
  ProviderOverridesSchema,
  ProviderPaseoToolsPolicySchema,
  isPaseoSupportedProvider,
} from "./provider-config.js";

describe("provider Paseo-tool policy", () => {
  test("allows custom Codex routes without letting unsupported builtins spoof inheritance", () => {
    expect(isPaseoSupportedProvider("codex-proxy", { extends: "codex" })).toBe(true);
    expect(isPaseoSupportedProvider("opencode", { extends: "codex" })).toBe(false);
  });

  test("treats Pi as a first-class supported builtin", () => {
    expect(isPaseoSupportedProvider("pi")).toBe(true);
    // Support comes from the builtin allowlist, not from spoofing Codex inheritance.
    expect(isPaseoSupportedProvider("pi", { extends: "codex" })).toBe(true);
  });

  test("accepts native Antigravity as a builtin provider without ACP inheritance", () => {
    expect(
      ProviderOverridesSchema.parse({
        "gemini-antigravity": { command: ["agy"] },
      })["gemini-antigravity"],
    ).toEqual({ command: ["agy"] });
  });

  test("accepts arbitrary tool IDs and leaves an empty policy enabled by default", () => {
    expect(
      ProviderPaseoToolsPolicySchema.parse({
        disabledTools: ["future_tool", "browser_future_tool"],
      }),
    ).toEqual({
      disabledTools: ["future_tool", "browser_future_tool"],
    });
    expect(ProviderPaseoToolsPolicySchema.parse({})).toEqual({});
    expect(ProviderOverrideSchema.parse({}).paseoTools).toBeUndefined();
  });

  test("accepts paseoTools on persisted provider overrides", () => {
    expect(
      ProviderOverrideSchema.parse({
        extends: "claude",
        paseoTools: {
          enabled: false,
          disabledTools: ["create_workspace"],
        },
      }).paseoTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["create_workspace"],
    });
  });

  test("accepts a fail-closed allowlist and rejects mixed allowlist and denylist policies", () => {
    expect(
      ProviderPaseoToolsPolicySchema.parse({
        enabled: true,
        allowedTools: ["list_agents", "get_agent_status"],
      }),
    ).toEqual({
      enabled: true,
      allowedTools: ["list_agents", "get_agent_status"],
    });

    expect(() =>
      ProviderPaseoToolsPolicySchema.parse({
        allowedTools: ["list_agents"],
        disabledTools: ["create_agent"],
      }),
    ).toThrow("allowedTools and disabledTools are mutually exclusive");
  });

  test("accepts paseoTools when reading and patching mutable daemon providers", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: true },
        providers: {
          codex: {
            paseoTools: { enabled: true, allowedTools: ["list_agents"] },
          },
        },
      }).providers.codex?.paseoTools,
    ).toEqual({
      enabled: true,
      allowedTools: ["list_agents"],
    });

    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          codex: {
            paseoTools: { disabledTools: ["browser_future_tool"] },
          },
        },
      }).providers?.codex?.paseoTools,
    ).toEqual({ disabledTools: ["browser_future_tool"] });
  });

  test("keeps Peer profile routing fields outside the strict legacy delegation object", () => {
    const config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      peerDelegation: {
        enabled: true,
        allowedModels: [{ provider: "codex", model: "gpt-5.6-luna" }],
        runMode: "unattended",
      },
      peerDelegationProfileIds: ["peer-scout"],
      peerDelegationProviderPriority: ["claude", "codex"],
      peerDelegationDefaultSubrole: "engineer",
      agentProfiles: [
        {
          id: "peer-scout",
          name: "Peer Scout",
          provider: "codex",
          peerSubrole: "scout",
        },
      ],
    });
    const patch = MutableDaemonConfigPatchSchema.parse({
      peerDelegationProfileIds: ["peer-scout", "peer-reviewer"],
      peerDelegationProviderPriority: ["codex", "claude"],
      peerDelegationDefaultSubrole: null,
    });

    expect(config.peerDelegationProfileIds).toEqual(["peer-scout"]);
    expect(config.peerDelegationProviderPriority).toEqual(["claude", "codex"]);
    expect(config.peerDelegationDefaultSubrole).toBe("engineer");
    expect(config.agentProfiles?.[0]?.peerSubrole).toBe("scout");
    expect(patch.peerDelegationProfileIds).toEqual(["peer-scout", "peer-reviewer"]);
    expect(patch.peerDelegationProviderPriority).toEqual(["codex", "claude"]);
    expect(patch.peerDelegationDefaultSubrole).toBeNull();
  });

  test("keeps credential references and rejects credential material in mutable provider env", () => {
    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          "codex-proxy": {
            credentialRef: "codex-proxy",
            env: { OPENAI_BASE_URL: "https://proxy.example/v1" },
          },
        },
      }).providers?.["codex-proxy"],
    ).toEqual({
      credentialRef: "codex-proxy",
      env: { OPENAI_BASE_URL: "https://proxy.example/v1" },
    });

    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        providers: { "codex-proxy": { env: { OPENAI_API_KEY: "must-not-persist" } } },
      }),
    ).toThrow("use foundation.credentials.set.request");

    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: { "codex-proxy": { env: { KEYBOARD_LAYOUT: "us" } } },
      }).providers?.["codex-proxy"]?.env,
    ).toEqual({ KEYBOARD_LAYOUT: "us" });
  });

  test("accepts explicit ACP native role drivers and rejects them on non-ACP providers", () => {
    expect(
      ProviderOverridesSchema.parse({
        cursor: {
          extends: "acp",
          label: "Cursor",
          command: ["cursor-agent", "acp"],
          roleBinding: { driver: "cursor-workspace-rule" },
        },
      }).cursor?.roleBinding,
    ).toEqual({ driver: "cursor-workspace-rule" });
    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          cursor: { roleBinding: { driver: "cursor-workspace-rule" } },
        },
      }).providers?.cursor?.roleBinding,
    ).toEqual({ driver: "cursor-workspace-rule" });
    expect(() =>
      ProviderOverridesSchema.parse({
        "custom-codex": {
          extends: "codex",
          label: "Custom Codex",
          roleBinding: { driver: "cursor-workspace-rule" },
        },
      }),
    ).toThrow(/may declare roleBinding only when it extends/u);
  });
});
