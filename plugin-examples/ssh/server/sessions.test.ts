import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { startSession } from "./sessions";

type Context = Parameters<typeof startSession>[1];
type CreateOptions = Parameters<Context["paseo"]["terminals"]["create"]>[0];

/** Records what the plugin asks the daemon for, and answers like the daemon would. */
function daemon(create: (options: CreateOptions) => Promise<unknown>) {
  const calls: CreateOptions[] = [];
  const context = {
    paseo: {
      terminals: {
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

  it("asks for a host update when the daemon still requires a workspace", async () => {
    const { context } = daemon(() => Promise.reject(new Error("workspaceId is required")));
    await expect(
      startSession({ target: { host: "build-box" }, label: "box" }, context),
    ).resolves.toEqual({
      ok: false,
      message: "Update the host to run SSH sessions outside a workspace.",
    });
  });

  it("reports any other daemon error as it is", async () => {
    const { context } = daemon(() =>
      Promise.reject(new Error("Update the host to use owned terminals.")),
    );
    await expect(
      startSession({ target: { host: "build-box" }, label: "box" }, context),
    ).resolves.toEqual({ ok: false, message: "Update the host to use owned terminals." });
  });
});
