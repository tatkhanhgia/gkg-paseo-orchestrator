import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { startSession } from "./sessions";

type Context = Parameters<typeof startSession>[1];
type CreateOptions = Parameters<Context["paseo"]["terminals"]["create"]>[0];

/**
 * Records what the plugin asks the daemon for, and answers like the daemon would. `capabilities`
 * is what the daemon's SDK reports; an older daemon reports none.
 */
function daemon(
  create: (options: CreateOptions) => Promise<unknown>,
  capabilities: { workspacelessOwned: boolean } | undefined = { workspacelessOwned: true },
) {
  const calls: CreateOptions[] = [];
  const context = {
    paseo: {
      terminals: {
        ...(capabilities ? { capabilities } : {}),
        create: vi.fn(async (options: CreateOptions) => {
          calls.push(options);
          return create(options);
        }),
      },
    },
  } as unknown as Context;
  return { context, calls };
}

const created = (options: CreateOptions) =>
  Promise.resolve({
    current: () => ({
      id: "term-1",
      workspaceId: "plugin:ssh",
      cwd: options.cwd ?? "",
      name: options.name ?? "",
      owner: "plugin:ssh",
    }),
  });

describe("startSession", () => {
  it("starts ssh in a terminal the plugin owns, in no workspace, from the home directory", async () => {
    const { context, calls } = daemon(created);

    const result = await startSession(
      { target: { host: "build-box", user: "deploy", port: 2222 }, label: "Build\tbox" },
      context,
    );

    expect(result).toEqual({
      ok: true,
      session: { id: "term-1", cwd: homedir(), name: "ssh Build box" },
    });
    expect(calls).toEqual([
      {
        cwd: homedir(),
        name: "ssh Build box",
        command: "ssh",
        args: ["-p", "2222", "-l", "deploy", "--", "build-box"],
        owned: true,
      },
    ]);
  });

  it.each(["-oProxyCommand=touch PWNED", "two words", ""])(
    "refuses the host %j without asking the daemon",
    async (host) => {
      const { context, calls } = daemon(created);
      const result = await startSession({ target: { host }, label: "x" }, context);
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining("Invalid SSH host"),
      });
      expect(calls).toEqual([]);
    },
  );

  it.each([
    { label: "reports no capabilities", capabilities: undefined },
    { label: "cannot omit the workspace", capabilities: { workspacelessOwned: false } },
  ])(
    "asks for a host update when the daemon $label, without creating anything",
    async ({ capabilities }) => {
      const { context, calls } = daemon(created, capabilities);
      await expect(
        startSession({ target: { host: "build-box" }, label: "box" }, context),
      ).resolves.toEqual({
        ok: false,
        message: "Update the host to run SSH sessions outside a workspace.",
      });
      expect(calls).toEqual([]);
    },
  );

  it("reports the daemon's own refusal as it is, even one that mentions a workspace", async () => {
    const { context } = daemon(() => Promise.reject(new Error("workspaceId is required")));
    await expect(
      startSession({ target: { host: "build-box" }, label: "box" }, context),
    ).resolves.toEqual({ ok: false, message: "workspaceId is required" });
  });
});
