import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StagingArea } from "./staging";

// StagingArea lives under the OS temp directory; TMPDIR points that into a sandbox here.
describe.skipIf(process.platform === "win32")("StagingArea", () => {
  let sandbox: string;
  let temp: string;
  let savedTmpdir: string | undefined;
  let staging: StagingArea;

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "ssh-staging-")));
    temp = path.join(sandbox, "tmp");
    await mkdir(temp);
    savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    staging = new StagingArea();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await staging.clear();
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("gives each download its own private directory and removes them all when cleared", async () => {
    const first = await staging.createDirectory();
    const second = await staging.createDirectory();

    expect(first).not.toBe(second);
    for (const directory of [first, second]) {
      expect(path.relative(temp, directory).split(path.sep)[0]).toMatch(/^paseo-ssh-/);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    await staging.clear();
    expect(await readdir(temp)).toEqual([]);
  });

  it("removes only directories inside its own area", async () => {
    await staging.createDirectory();
    const outside = path.join(sandbox, "keep");
    await mkdir(outside);

    await staging.remove(outside);
    await staging.remove(temp);

    expect(existsSync(outside)).toBe(true);
    expect((await readdir(temp)).length).toBe(1);
  });

  it("removes a directory once its scheduled time has passed, and not before", async () => {
    const directory = await staging.createDirectory();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    staging.scheduleRemoval(directory, 1000);
    vi.advanceTimersByTime(999);
    expect(existsSync(directory)).toBe(true);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    for (let attempt = 0; attempt < 200 && existsSync(directory); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(existsSync(directory)).toBe(false);
  });

  it("sweeps staging left by processes that are gone and keeps that of running ones", async () => {
    // A process that has exited, so its pid is not running (pids are not reused this quickly).
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const deadPid = Number(exited.stdout.toString());
    const stale = path.join(temp, "paseo-ssh-stale");
    const live = path.join(temp, "paseo-ssh-live");
    const unmarked = path.join(temp, "paseo-ssh-unmarked");
    const unrelated = path.join(temp, "other-stale");
    for (const directory of [stale, live, unmarked, unrelated]) await mkdir(directory);
    await writeFile(path.join(stale, "owner.pid"), String(deadPid));
    await writeFile(path.join(unrelated, "owner.pid"), String(deadPid));
    await writeFile(path.join(live, "owner.pid"), String(process.pid));
    const own = await staging.createDirectory();

    await staging.sweepStale();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unmarked)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(own)).toBe(true);
  });
});
