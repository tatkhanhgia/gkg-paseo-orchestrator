import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const daemonControl = vi.hoisted(() => ({
  startDaemonInstance: vi.fn(async () => ({ pid: 1, listen: "127.0.0.1:1" })),
  stopDaemonInstance: vi.fn(async () => ({ action: "stopped" })),
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startDaemonInstance: daemonControl.startDaemonInstance,
  stopDaemonInstance: daemonControl.stopDaemonInstance,
}));

import { launchLocalDaemon } from "./local-daemon.js";
import { runStopCommand } from "./stop.js";

function launchedPath(): string[] {
  const call = daemonControl.startDaemonInstance.mock.calls.at(-1) as unknown as
    | [{ env: NodeJS.ProcessEnv }]
    | undefined;
  return call?.[0].env.PATH?.split(path.delimiter) ?? [];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("local daemon launch environment", () => {
  test.skipIf(process.platform === "win32")(
    "appends user agent binary directories after the inherited PATH",
    async () => {
      const home = path.join(os.tmpdir(), "paseo-launch-path-user");
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", ["/usr/bin", "/bin"].join(path.delimiter));

      await launchLocalDaemon({ home: path.join(home, ".paseo") });

      expect(launchedPath()).toEqual([
        "/usr/bin",
        "/bin",
        path.join(home, "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".opencode", "bin"),
        path.join(home, ".bun", "bin"),
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps an inherited user directory in place instead of duplicating it",
    async () => {
      const home = path.join(os.tmpdir(), "paseo-launch-path-dedupe");
      const openCodeBin = path.join(home, ".opencode", "bin");
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", [openCodeBin, "/usr/bin"].join(path.delimiter));

      await launchLocalDaemon({ home: path.join(home, ".paseo"), foreground: true });

      expect(launchedPath()).toEqual([
        openCodeBin,
        "/usr/bin",
        path.join(home, "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".bun", "bin"),
      ]);
    },
  );
});

describe("daemon stop budget", () => {
  test("waits past the supervisor's 25-second graceful worker cleanup by default", async () => {
    await runStopCommand(
      { daemonTarget: { kind: "instance", home: "/tmp/paseo-stop-budget" } },
      {} as never,
    );

    const options = daemonControl.stopDaemonInstance.mock.calls[0]?.[1] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBe(35_000);
  });
});
