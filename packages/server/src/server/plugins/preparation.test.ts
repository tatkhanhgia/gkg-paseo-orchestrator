import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginBuild } from "./preparation.js";

const roots: string[] = [];
const logger = pino({ level: "silent" });

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-plugin-build-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin build preparation", () => {
  it("runs declared commands without a shell", async () => {
    const root = await createRoot();

    await expect(
      runPluginBuild(root, [[process.execPath, "-e", "process.stdout.write('built')"]], logger),
    ).resolves.toBeUndefined();
  });

  it("reports a non-zero command with its bounded output", async () => {
    const root = await createRoot();

    await expect(
      runPluginBuild(
        root,
        [[process.execPath, "-e", "process.stderr.write('broken'); process.exit(7)"]],
        logger,
      ),
    ).rejects.toThrow(/failed \(exit 7\).*broken/s);
  });

  it("terminates a build command that exceeds its execution budget", async () => {
    const root = await createRoot();

    await expect(
      runPluginBuild(
        root,
        [[process.execPath, "-e", "setInterval(() => undefined, 1_000)"]],
        logger,
        {
          timeoutMs: 50,
          gracefulTerminationMs: 100,
          forceTerminationMs: 100,
        },
      ),
    ).rejects.toThrow("timed out after 50ms");
  });
});
