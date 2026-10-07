import { describe, expect, it } from "vitest";

import { AGENT_PROVIDER_DEFINITIONS, getUnattendedModeId } from "./provider-manifest";

describe("shipping provider support defaults", () => {
  it("enables only currently supported built-in provider families", () => {
    const enabledByDefault = new Map(
      AGENT_PROVIDER_DEFINITIONS.map((provider) => [
        provider.id,
        provider.enabledByDefault !== false,
      ]),
    );

    expect(Object.fromEntries(enabledByDefault)).toMatchObject({
      claude: true,
      codex: true,
      "gemini-antigravity": true,
      copilot: false,
      opencode: false,
      pi: false,
      omp: false,
    });
  });
});

describe("unattended provider modes", () => {
  it("lets Pi satisfy unattended-only policies through its full-access mode", () => {
    expect(getUnattendedModeId("pi")).toBe("full-access");
  });
});
