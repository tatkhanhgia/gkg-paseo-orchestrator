import { expect, test, vi } from "vitest";
import { createTerminalActions } from "./index.js";

test("an older host rejects terminal operations before sending requests", async () => {
  const unexpectedRequest = () => {
    throw new Error("Unexpected daemon request");
  };
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "older-host",
        hostname: null,
        version: null,
        features: {},
      }),
      createTerminal: unexpectedRequest,
      listTerminals: unexpectedRequest,
      sendTerminalInput: unexpectedRequest,
      captureTerminal: unexpectedRequest,
      killTerminal: unexpectedRequest,
    },
    unexpectedRequest,
  );

  await expect(terminals.create({ workspaceId: "wks_existing" })).rejects.toThrow(
    "Update the host",
  );
  await expect(terminals.list({ workspaceId: "wks_existing" })).rejects.toThrow("Update the host");
  const terminal = terminals.ref("terminal-existing");
  expect(terminal.current()).toBeNull();
  expect(() => terminal.write("text")).toThrow("Update the host");
  expect(() => terminal.sendKeys(["Enter"])).toThrow("Update the host");
  expect(() => terminal.capture()).toThrow("Update the host");
  await expect(terminal.kill()).rejects.toThrow("Update the host");
});

test("owned terminals send the API's owner and require both a scope owner and a capable host", async () => {
  const createTerminal = vi.fn(async () => ({
    terminal: { id: "t1", workspaceId: "wks_1", cwd: "/w", name: "ssh", owner: "plugin:ssh" },
    error: null,
    requestId: "r",
  }));
  const listTerminals = vi.fn(async () => ({ terminals: [], requestId: "r" }));
  const serverInfo = (features: Record<string, boolean>) => () => ({
    status: "server_info" as const,
    serverId: "host",
    hostname: null,
    version: null,
    features: { workspaceTerminals: true, ...features },
  });
  const make = (features: Record<string, boolean>, owner?: string) =>
    createTerminalActions(
      {
        ensureConnected: () => {},
        getLastServerInfoMessage: serverInfo(features),
        createTerminal,
        listTerminals,
      } as unknown as Parameters<typeof createTerminalActions>[0],
      async () => "/w",
      owner,
    );

  const capable = make({ "owned-terminals": true }, "plugin:ssh");
  const created = await capable.create({ workspaceId: "wks_1", owned: true });
  expect(created.current()?.owner).toBe("plugin:ssh");
  expect(createTerminal).toHaveBeenCalledWith("/w", undefined, undefined, {
    workspaceId: "wks_1",
    owner: "plugin:ssh",
  });
  await capable.list({ workspaceId: "wks_1", owned: true });
  expect(listTerminals).toHaveBeenLastCalledWith(undefined, undefined, {
    workspaceId: "wks_1",
    owner: "plugin:ssh",
  });
  await capable.list({ workspaceId: "wks_1" });
  expect(listTerminals).toHaveBeenLastCalledWith(undefined, undefined, {
    workspaceId: "wks_1",
  });

  await expect(
    make({ "owned-terminals": true }).create({ workspaceId: "wks_1", owned: true }),
  ).rejects.toThrow("terminalOwner");
  await expect(make({}, "plugin:ssh").list({ workspaceId: "wks_1", owned: true })).rejects.toThrow(
    "Update the host to use owned terminals.",
  );
  expect(createTerminal).toHaveBeenCalledTimes(1);
});
