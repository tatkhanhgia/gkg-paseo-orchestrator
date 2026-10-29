import { describe, expect, it } from "vitest";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { buildAcpProviderConfigPatch, getAcpProviderCatalog } from "./use-acp-provider-catalog";

function findProvider(id: string) {
  const entry = ACP_PROVIDER_CATALOG.find((provider) => provider.id === id);
  if (!entry) {
    throw new Error(`Missing ACP provider catalog entry: ${id}`);
  }
  return entry;
}

describe("ACP provider catalog", () => {
  it("offers only Cursor on the currently supported product surface", () => {
    expect(getAcpProviderCatalog().map((entry) => entry.id)).toEqual(["cursor"]);
    expect(getAcpProviderCatalog().map((entry) => entry.id)).not.toContain("minimax-code");
    expect(getAcpProviderCatalog().map((entry) => entry.id)).not.toContain("fast-agent");
    expect(getAcpProviderCatalog().map((entry) => entry.id)).not.toContain("hermes");
  });

  it.each(["devin", "hermes", "kiro"])(
    "#7087: %s supplies its provider mark to the catalog picker",
    (provider) => {
      expect(findProvider(provider).iconSvg).toContain("<svg");
    },
  );

  it("vendors provider entries with unique ids and concrete commands", () => {
    const ids = new Set<string>();

    for (const entry of ACP_PROVIDER_CATALOG) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.title).not.toBe("");
      expect(entry.description).not.toBe("");
      expect(entry.installLink).toMatch(/^https:\/\//);
      expect(entry.command.length).toBeGreaterThan(0);
      expect(entry.command[0]).not.toBe("");
    }
  });

  it("bundles SVG icons for catalog entries that declare an icon", () => {
    const entriesWithIcons = ACP_PROVIDER_CATALOG.filter((entry) => entry.iconSvg !== null);

    expect(entriesWithIcons.length).toBeGreaterThan(0);
    for (const entry of entriesWithIcons) {
      expect(entry.iconSvg).toContain("<svg");
    }
  });

  it("does not offer Pi's unsupported ACP adapter", () => {
    expect(ACP_PROVIDER_CATALOG.some((entry) => entry.id === "pi-acp")).toBe(false);
  });

  it("does not offer builtin native Antigravity as an ACP provider", () => {
    expect(ACP_PROVIDER_CATALOG.some((entry) => entry.id === "gemini-antigravity")).toBe(false);
  });

  it("uses PATH commands for entries that were binary distributions upstream", () => {
    expect(findProvider("amp-acp").command).toEqual(["amp-acp"]);
    expect(findProvider("cursor").command).toEqual(["cursor-agent", "acp"]);
    expect(findProvider("codewhale").command).toEqual(["codewhale", "serve", "--acp"]);
    expect(findProvider("devin").command).toEqual(["devin", "acp"]);
    expect(findProvider("goose").command).toEqual(["goose", "acp"]);
    expect(findProvider("hoplite").command).toEqual(["hoplite", "acp"]);
    expect(findProvider("junie").command).toEqual(["junie", "--acp", "true"]);
    expect(findProvider("kiro").command).toEqual(["kiro-cli", "acp"]);
    expect(findProvider("poolside").command).toEqual(["pool", "acp"]);
    expect(findProvider("traecli").command).toEqual(["traecli", "acp", "serve"]);
  });

  it("retains MiniMax Code as raw upstream metadata without product qualification", () => {
    expect(findProvider("minimax-code")).toMatchObject({
      title: "MiniMax Code",
      version: "0.6.13",
      command: ["npx", "-y", "@minimax-ai/code@0.6.13", "acp"],
    });
    expect(findProvider("minimax-code").iconSvg).toContain("<svg");
  });

  it("retains stable fast-agent metadata with the exact uvx invocation", () => {
    const fastAgent = findProvider("fast-agent");
    expect(fastAgent.title).toBe("fast-agent");
    expect(fastAgent.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fastAgent.command).toEqual([
      "uvx",
      "--from",
      `fast-agent-acp==${fastAgent.version}`,
      "fast-agent-acp",
      "-x",
    ]);
    expect(findProvider("fast-agent").iconSvg).toContain("<svg");
  });

  it("offers Hoplite through its local ACP bridge with the Hoplite mark", () => {
    expect(findProvider("hoplite")).toMatchObject({
      title: "Hoplite",
      command: ["hoplite", "acp"],
      installLink: "https://hoplite.sh/docs/cli#install",
    });
    expect(buildAcpProviderConfigPatch(findProvider("hoplite"), true)).toEqual({
      providers: {
        hoplite: { enabled: true },
      },
    });
    // GKG filters the offered catalog to Cursor; the vendored catalog keeps upstream ordering.
    const ids = ACP_PROVIDER_CATALOG.map((entry) => entry.id);
    expect(ids.indexOf("hermes")).toBeLessThan(ids.indexOf("hoplite"));
    expect(ids.indexOf("hoplite")).toBeLessThan(ids.indexOf("junie"));
    expect(findProvider("hoplite").iconSvg).toContain('fill="currentColor"');
  });

  it.each([undefined, false])(
    "rejects unsupported bundled Hoplite before producing a patch (%s)",
    (supported) => {
      expect(() => buildAcpProviderConfigPatch(findProvider("hoplite"), supported)).toThrow(
        "Update the host to add Hoplite.",
      );
    },
  );

  it("maps a catalog entry to the daemon provider config patch", () => {
    expect(buildAcpProviderConfigPatch(findProvider("amp-acp"))).toEqual({
      providers: {
        "amp-acp": {
          extends: "acp",
          label: "Amp",
          description: "ACP wrapper for Amp - the frontier coding agent",
          command: ["amp-acp"],
          env: {},
        },
      },
    });
  });

  it("preserves provider env in the daemon config patch", () => {
    const patch = buildAcpProviderConfigPatch(findProvider("auggie"));

    expect(patch.providers?.auggie?.env).toEqual({
      AUGMENT_DISABLE_AUTO_UPDATE: "1",
    });
  });

  it("registers Gajae Code with its ACP command and permission-prompt env", () => {
    const patch = buildAcpProviderConfigPatch(findProvider("gjc"));

    expect(patch.providers?.gjc?.command).toEqual(["gjc", "acp"]);
    expect(patch.providers?.gjc?.env).toEqual({ GJC_ACP_PERMISSION_MODE: "prompt" });
  });

  it("preserves provider params in the daemon config patch", () => {
    const droidPatch = buildAcpProviderConfigPatch(findProvider("factory-droid"));

    expect(droidPatch.providers?.["factory-droid"]?.params).toEqual({
      supportsMcpServers: false,
    });
  });

  it("keeps native role selection out of provider connection JSON", () => {
    expect(buildAcpProviderConfigPatch(findProvider("cursor")).providers?.cursor).toMatchObject({
      extends: "acp",
      command: ["cursor-agent", "acp"],
    });
    expect(
      buildAcpProviderConfigPatch(findProvider("cursor")).providers?.cursor,
    ).not.toHaveProperty("roleBinding");
  });
});
