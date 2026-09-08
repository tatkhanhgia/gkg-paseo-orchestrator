import { describe, expect, it, vi } from "vitest";

const refreshWorkspaceDirectory = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ refreshWorkspaceDirectory }),
}));

import { refreshWorkspaceScriptsAfterSave } from "./project-settings-refresh";

describe("refreshWorkspaceScriptsAfterSave", () => {
  it("asks the host runtime to refresh the workspace directory for the saved host", () => {
    refreshWorkspaceDirectory.mockResolvedValueOnce(undefined);

    refreshWorkspaceScriptsAfterSave("server-1");

    expect(refreshWorkspaceDirectory).toHaveBeenCalledWith({ serverId: "server-1" });
  });

  it("does not throw or reject when the refresh call fails", async () => {
    refreshWorkspaceDirectory.mockRejectedValueOnce(new Error("unknown host runtime"));

    expect(() => refreshWorkspaceScriptsAfterSave("server-2")).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
  });
});
