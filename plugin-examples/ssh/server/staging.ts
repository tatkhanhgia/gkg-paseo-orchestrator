import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const OWNER_FILE = "owner.pid";
const PREFIX = "paseo-ssh-";

function isInside(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  );
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Where downloads wait on the daemon host until the device has them. It is not a workspace: one
 * private (0700) root per plugin process under the OS temp directory, marked with the process id,
 * and one fresh directory per download inside it, so names never collide and nothing is
 * overwritten. Each directory is removed after the device saved the file, after a time limit, or
 * when the plugin stops.
 */
export class StagingArea {
  private root: Promise<string> | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** A new, empty, private directory for one download. */
  async createDirectory(): Promise<string> {
    return mkdtemp(path.join(await this.ensureRoot(), "d-"));
  }

  /**
   * Removes `directory` after `delayMs`, replacing any earlier schedule for it. Only directories
   * inside this area are ever removed.
   */
  scheduleRemoval(directory: string, delayMs: number): void {
    clearTimeout(this.timers.get(directory));
    const timer = setTimeout(() => void this.remove(directory), delayMs);
    timer.unref?.();
    this.timers.set(directory, timer);
  }

  async remove(directory: string): Promise<void> {
    clearTimeout(this.timers.get(directory));
    this.timers.delete(directory);
    const root = this.root ? await this.root.catch(() => null) : null;
    if (!root || !isInside(root, directory)) return;
    await rm(directory, { recursive: true, force: true });
  }

  /** Removes everything this process staged. Used when the plugin stops. */
  async clear(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const root = this.root;
    this.root = null;
    const resolved = root ? await root.catch(() => null) : null;
    if (resolved) await rm(resolved, { recursive: true, force: true });
  }

  /**
   * Removes staging roots left behind by plugin processes that are no longer running, such as
   * after a crash. Roots of running processes, including other daemons' plugins, are kept.
   */
  async sweepStale(): Promise<void> {
    const base = tmpdir();
    const names = await readdir(base).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => name.startsWith(PREFIX))
        .map(async (name) => {
          const directory = path.join(base, name);
          const owner = Number(
            await readFile(path.join(directory, OWNER_FILE), "utf8").catch(() => ""),
          );
          if (!Number.isInteger(owner) || owner <= 0) return;
          if (owner === process.pid || isRunning(owner)) return;
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }),
    );
  }

  private ensureRoot(): Promise<string> {
    if (!this.root) {
      this.root = (async () => {
        const directory = await realpath(await mkdtemp(path.join(tmpdir(), PREFIX)));
        await writeFile(path.join(directory, OWNER_FILE), String(process.pid), { mode: 0o600 });
        return directory;
      })();
      // A failed creation is retried on the next download instead of failing every one after it.
      this.root.catch(() => {
        this.root = null;
      });
    }
    return this.root;
  }
}
