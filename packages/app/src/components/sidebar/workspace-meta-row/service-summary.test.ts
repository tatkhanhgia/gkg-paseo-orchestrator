import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { en } from "@/i18n/resources/en";
import { selectWorkspaceServiceSummary, workspaceServiceLabelKey } from "./service-summary";

type Script = SidebarWorkspaceEntry["scripts"][number];

function script(overrides: Partial<Script>): Script {
  return {
    scriptName: "dev",
    type: "service",
    hostname: "localhost",
    port: null,
    proxyUrl: null,
    lifecycle: "running",
    health: null,
    exitCode: null,
    terminalId: null,
    ...overrides,
  } as Script;
}

describe("selectWorkspaceServiceSummary", () => {
  it("returns nothing when no service is running", () => {
    expect(selectWorkspaceServiceSummary([])).toBeNull();
    expect(selectWorkspaceServiceSummary([script({ lifecycle: "stopped" })])).toBeNull();
  });

  it("reports a running service by name", () => {
    expect(selectWorkspaceServiceSummary([script({ scriptName: "web" })])).toEqual({
      name: "web",
      health: null,
    });
  });

  it("ignores plain commands entirely", () => {
    // A test watcher running says nothing about whether the workspace is up.
    expect(
      selectWorkspaceServiceSummary([script({ scriptName: "test", type: "script" })]),
    ).toBeNull();
  });

  it("prefers an unhealthy service over a healthy one regardless of order", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", health: "healthy" }),
        script({ scriptName: "api", health: "unhealthy" }),
      ]),
    ).toEqual({ name: "api", health: "unhealthy" });
  });

  it("takes the first running service when none is failing", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", health: "healthy" }),
        script({ scriptName: "api", health: null }),
      ]),
    ).toEqual({ name: "web", health: "healthy" });
  });

  it("skips a stopped service to reach a running one", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", lifecycle: "stopped" }),
        script({ scriptName: "api" }),
      ]),
    ).toEqual({ name: "api", health: null });
  });
});

describe("workspaceServiceLabelKey", () => {
  it("names an unhealthy service differently from a running one", () => {
    expect(workspaceServiceLabelKey({ name: "web", health: "unhealthy" })).toBe(
      "sidebar.workspace.status.serviceUnhealthy",
    );
  });

  it.each([["healthy"], [null]] as const)("treats %s as simply running", (health) => {
    expect(workspaceServiceLabelKey({ name: "web", health })).toBe(
      "sidebar.workspace.status.serviceRunning",
    );
  });
});

describe("workspaceServiceLabelKey i18n resolution", () => {
  async function realT() {
    const i18n = createInstance();
    await i18n.init({
      compatibilityJSON: "v4",
      lng: "en",
      fallbackLng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
    return i18n.t.bind(i18n);
  }

  it("resolves the running key to real English copy with the service name interpolated", async () => {
    const t = await realT();
    const key = workspaceServiceLabelKey({ name: "web", health: "healthy" });
    expect(t(key, { name: "web" })).toBe("Service web running");
  });

  it("resolves the unhealthy key to real English copy with the service name interpolated", async () => {
    const t = await realT();
    const key = workspaceServiceLabelKey({ name: "api", health: "unhealthy" });
    expect(t(key, { name: "api" })).toBe("Service api unhealthy");
  });

  it("does not fall back to the raw key (the U4 regression)", async () => {
    const t = await realT();
    const key = workspaceServiceLabelKey({ name: "web", health: null });
    expect(t(key, { name: "web" })).not.toBe(key);
  });
});
