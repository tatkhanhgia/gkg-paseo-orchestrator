import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelTransfer,
  listRemoteFiles,
  listWorkspaceFiles,
  startDownload,
  startUpload,
  transferStatus,
} from "./files";
import type { Transfer } from "../shared/contracts";
import { MAX_FINISHED_TRANSFERS } from "./transfers";

const SFTP_SERVER = [
  "/usr/libexec/sftp-server",
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
].find((candidate) => existsSync(candidate));

const HOSTILE_NAME = `-rf "q"; $(touch PWNED) '!x'.txt`;
// Serves sftp-server but delays every reply, so a transfer lasts long enough to be cancelled.
const RELAY_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.env.FAKE_SFTP_SERVER, ["-d", process.env.FAKE_SFTP_HOME], {
  stdio: ["pipe", "pipe", "inherit"],
});
process.stdin.pipe(child.stdin);
const delay = Number(process.env.FAKE_SSH_THROTTLE_MS);
child.stdout.on("data", (chunk) => {
  child.stdout.pause();
  setTimeout(() => process.stdout.write(chunk, () => child.stdout.resume()), delay);
});
child.on("exit", (code) => process.exit(code ?? 0));
`;

// A minimal SFTP server whose STAT answers describe a regular file but report no size.
const HOSTILE_SCRIPT = `
let buffered = Buffer.alloc(0);
const send = (type, body) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = type;
  process.stdout.write(Buffer.concat([header, body]));
};
const handle = (frame) => {
  const id = frame.subarray(1, 5);
  if (frame[0] === 1) send(2, Buffer.from([0, 0, 0, 3]));
  else if (frame[0] === 17) {
    const attrs = Buffer.alloc(8);
    attrs.writeUInt32BE(0x4, 0);
    attrs.writeUInt32BE(0o100644, 4);
    send(105, Buffer.concat([id, attrs]));
  } else {
    const status = Buffer.alloc(16);
    status.writeUInt32BE(4, 0);
    send(101, Buffer.concat([id, status]));
  }
};
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const length = buffered.readUInt32BE(0);
    handle(buffered.subarray(4, 4 + length));
    buffered = buffered.subarray(4 + length);
  }
});
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Context = Parameters<typeof startDownload>[1];

async function waitFor(
  transferId: string,
  done: (transfer: Transfer) => boolean,
): Promise<Transfer> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = transferStatus({ transferId });
    if (status.ok && done(status.transfer)) return status.transfer;
    if (!status.ok) throw new Error(`transfer vanished: ${status.message}`);
    await sleep(25);
  }
  throw new Error("transfer did not reach the expected state");
}

const isEnded = (transfer: Transfer) => transfer.state !== "running";
const hasProgress = (transfer: Transfer) => transfer.bytesDone > 0;
const progressOrEnded = (transfer: Transfer) => hasProgress(transfer) || isEnded(transfer);

const failures = <Result extends { ok: boolean }>(results: Result[]) =>
  results.filter((result) => !result.ok);
const successes = <Result extends { ok: boolean }>(results: Result[]) =>
  results.filter((result) => result.ok);

/** Starts a download and waits for it, flattening start and final errors into one result. */
async function downloadAndWait(input: Parameters<typeof startDownload>[0], context: Context) {
  const started = await startDownload(input, context);
  if (!started.ok) return started;
  const transfer = await waitFor(started.transferId, isEnded);
  if (transfer.state === "done") {
    return { ok: true as const, fileName: transfer.fileName, size: transfer.bytesDone };
  }
  return { ok: false as const, ...transfer.error! };
}

async function uploadAndWait(input: Parameters<typeof startUpload>[0], context: Context) {
  const started = await startUpload(input, context);
  if (!started.ok) return started;
  const transfer = await waitFor(started.transferId, isEnded);
  if (transfer.state === "done") {
    return { ok: true as const, remotePath: transfer.remotePath!, size: transfer.bytesDone };
  }
  return { ok: false as const, ...transfer.error! };
}

type Listing = { ok: true; entries: { name: string }[] } | { ok: false };

function entriesByName<Entry extends { name: string }>(entries: Entry[]): Record<string, Entry> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
}

function entryNames(result: Listing): string[] {
  return result.ok ? result.entries.map((entry) => entry.name) : [];
}

const NAMES = ["t1", "t2", "t3", "t4", "t5"];

const TARGET = { host: "build-box", user: "deploy", port: 2222 };

// These tests run the real handlers. `ssh` on PATH is a script that records its argv and then
// serves the real OpenSSH `sftp-server` over stdio, so the SFTP bytes, the spawn, and the file
// systems on both sides are real. Only the network hop is replaced.
const listOnce = () => listRemoteFiles({ target: TARGET });

describe.skipIf(!SFTP_SERVER || process.platform === "win32")("file browsing over sftp", () => {
  let sandbox: string;
  let remoteHome: string;
  let workspace: string;
  let argvLog: string;
  let savedPath: string | undefined;
  const big = randomBytes(700 * 1024);

  const context = () =>
    ({
      paseo: {
        workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: workspace }) }) },
      },
    }) as never;

  async function installFakeSsh(): Promise<void> {
    const bin = path.join(sandbox, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "ssh"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" >> "$FAKE_SSH_ARGV_LOG"',
        'if [ -n "$FAKE_SSH_STDERR" ]; then printf "%s\\n" "$FAKE_SSH_STDERR" >&2; exit 255; fi',
        'if [ -n "$FAKE_SSH_HOSTILE" ]; then exec "$FAKE_NODE" "$FAKE_SSH_HOSTILE"; fi',
        'if [ -n "$FAKE_SSH_THROTTLE_MS" ]; then exec "$FAKE_NODE" "$FAKE_SSH_RELAY"; fi',
        `exec ${SFTP_SERVER} -d "$FAKE_SFTP_HOME"`,
      ].join("\n"),
    );
    await chmod(path.join(bin, "ssh"), 0o755);
    await writeFile(path.join(bin, "relay.js"), RELAY_SCRIPT);
    await writeFile(path.join(bin, "hostile.js"), HOSTILE_SCRIPT);
    process.env.FAKE_NODE = process.execPath;
    process.env.FAKE_SFTP_SERVER = SFTP_SERVER;
    process.env.FAKE_SSH_RELAY = path.join(bin, "relay.js");
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  }

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "ssh-files-")));
    remoteHome = path.join(sandbox, "remote");
    workspace = path.join(sandbox, "workspace");
    argvLog = path.join(sandbox, "argv.log");
    await mkdir(path.join(remoteHome, "docs"), { recursive: true });
    await mkdir(path.join(workspace, "sub"), { recursive: true });
    await writeFile(path.join(remoteHome, "big.bin"), big);
    await writeFile(path.join(remoteHome, "empty.txt"), "");
    await writeFile(path.join(remoteHome, HOSTILE_NAME), "hostile");
    await writeFile(path.join(remoteHome, "weird\nname\\.txt"), "x");
    await symlink("docs", path.join(remoteHome, "link-dir"));
    await symlink("big.bin", path.join(remoteHome, "link-file"));
    await symlink("nope", path.join(remoteHome, "link-broken"));
    await writeFile(path.join(workspace, "report.txt"), "report body");
    await writeFile(path.join(workspace, "sub", "inner.txt"), "inner body");
    await writeFile(path.join(workspace, "big-up.bin"), big);
    await installFakeSsh();
    process.env.FAKE_SSH_ARGV_LOG = argvLog;
    process.env.FAKE_SFTP_HOME = remoteHome;
    delete process.env.FAKE_SSH_STDERR;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    delete process.env.FAKE_SSH_ARGV_LOG;
    delete process.env.FAKE_SFTP_HOME;
    delete process.env.FAKE_SSH_STDERR;
    delete process.env.FAKE_SSH_THROTTLE_MS;
    delete process.env.FAKE_SSH_HOSTILE;
    await rm(sandbox, { recursive: true, force: true });
  });

  async function spawnedArgv(): Promise<string[]> {
    return existsSync(argvLog) ? (await readFile(argvLog, "utf8")).split("\n").slice(0, -1) : [];
  }

  async function expectNoInjection(): Promise<void> {
    for (const directory of [remoteHome, workspace, sandbox, process.cwd()]) {
      expect(existsSync(path.join(directory, "PWNED"))).toBe(false);
    }
  }

  describe("ssh invocation", () => {
    it("runs batch-mode ssh with strict host keys, no shared connection, and the sftp subsystem", async () => {
      await listRemoteFiles({ target: TARGET });
      const argv = await spawnedArgv();
      expect(argv).toEqual(
        expect.arrayContaining([
          "BatchMode=yes",
          "StrictHostKeyChecking=yes",
          "ControlMaster=no",
          "ControlPath=none",
        ]),
      );
      expect(argv.join(" ")).not.toMatch(/StrictHostKeyChecking=(no|accept-new|ask)/);
      expect(argv.slice(argv.indexOf("-p"))).toEqual([
        "-p",
        "2222",
        "-l",
        "deploy",
        "-s",
        "--",
        "build-box",
        "sftp",
      ]);
    });

    it.each(["-oProxyCommand=touch PWNED", "two words", "a\nb"])(
      "refuses the host %j before starting ssh",
      async (host) => {
        await expect(listRemoteFiles({ target: { host } })).resolves.toMatchObject({
          ok: false,
          code: "invalid",
        });
        expect(await spawnedArgv()).toEqual([]);
        await expectNoInjection();
      },
    );

    it("tells the user a key or ssh-agent is needed when ssh cannot authenticate", async () => {
      process.env.FAKE_SSH_STDERR = "deploy@build-box: Permission denied (publickey,password).";
      await expect(listRemoteFiles({ target: TARGET })).resolves.toEqual({
        ok: false,
        code: "auth",
        message: "This host needs a key or ssh-agent for file browsing; the terminal still works.",
      });
    });

    it("tells the user to use the terminal when the host key is not trusted", async () => {
      process.env.FAKE_SSH_STDERR = "Host key verification failed.";
      await expect(listRemoteFiles({ target: TARGET })).resolves.toMatchObject({
        ok: false,
        code: "host-key",
        message: expect.stringContaining("Connect once with the terminal"),
      });
    });
  });

  describe("remote listing", () => {
    it("lists the remote home with kinds, sizes, and times, directories first", async () => {
      const result = await listRemoteFiles({ target: TARGET });
      expect(result).toMatchObject({ ok: true, path: remoteHome, parent: sandbox });
      if (!result.ok) return;
      const byName = entriesByName(result.entries);
      expect(entryNames(result).slice(0, 2)).toEqual(["docs", "link-dir"]);
      expect(byName["big.bin"]).toMatchObject({ kind: "file", size: big.length });
      expect(byName["empty.txt"]).toMatchObject({ kind: "file", size: 0 });
      expect(byName["link-dir"]).toMatchObject({ kind: "directory", size: null });
      expect(byName["link-file"]).toMatchObject({ kind: "file", size: big.length });
      expect(byName["link-broken"]).toMatchObject({ kind: "symlink", size: null });
      const expectedMtime = Math.floor(
        (await stat(path.join(remoteHome, "big.bin"))).mtimeMs / 1000,
      );
      expect(byName["big.bin"].mtime).toBe(expectedMtime);
    });

    it("returns names that would break a shell or a batch file as plain data", async () => {
      const result = await listRemoteFiles({ target: TARGET });
      expect(entryNames(result)).toEqual(
        expect.arrayContaining([HOSTILE_NAME, "weird\nname\\.txt"]),
      );
      await expectNoInjection();
    });

    it("navigates into a directory, even through a link", async () => {
      await writeFile(path.join(remoteHome, "docs", "note.txt"), "n");
      const viaLink = await listRemoteFiles({ target: TARGET, path: `${remoteHome}/link-dir` });
      expect(viaLink).toMatchObject({ ok: true, path: path.join(remoteHome, "docs") });
      expect(entryNames(viaLink)).toEqual(["note.txt"]);
    });

    it("treats a path full of shell and batch syntax as a name that does not exist", async () => {
      const hostile = `${remoteHome}/$(touch PWNED);"\n!rm -rf /`;
      await expect(listRemoteFiles({ target: TARGET, path: hostile })).resolves.toMatchObject({
        ok: false,
        code: "not-found",
      });
      await expectNoInjection();
    });

    it("refuses a file as a directory and a NUL byte without starting ssh", async () => {
      await expect(
        listRemoteFiles({ target: TARGET, path: `${remoteHome}/big.bin` }),
      ).resolves.toMatchObject({ ok: false, code: "not-a-directory" });
      const spawnedBefore = (await spawnedArgv()).length;
      await expect(listRemoteFiles({ target: TARGET, path: "a\0b" })).resolves.toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect((await spawnedArgv()).length).toBe(spawnedBefore);
    });
  });

  describe("workspace listing", () => {
    it("lists the workspace directory the daemon resolves for the workspace id", async () => {
      const result = await listWorkspaceFiles({ workspaceId: "w1" }, context());
      expect(result).toMatchObject({ ok: true, root: workspace, directory: "", parent: null });
      expect(entryNames(result)).toEqual(["sub", "big-up.bin", "report.txt"]);
    });

    it("refuses a directory outside the workspace", async () => {
      await symlink(remoteHome, path.join(workspace, "escape"));
      await expect(
        listWorkspaceFiles({ workspaceId: "w1", directory: "escape" }, context()),
      ).resolves.toMatchObject({ ok: false, code: "invalid" });
    });
  });

  describe("download", () => {
    it("copies a multi-chunk file byte for byte into the workspace directory", async () => {
      const result = await downloadAndWait(
        { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/big.bin` },
        context(),
      );
      expect(result).toEqual({ ok: true, fileName: "big.bin", size: big.length });
      expect(Buffer.compare(await readFile(path.join(workspace, "big.bin")), big)).toBe(0);
    });

    it("copies empty files, linked files, and files with hostile names", async () => {
      for (const [remote, fileName, content] of [
        ["empty.txt", "empty.txt", Buffer.alloc(0)],
        ["link-file", "link-file", big],
        [HOSTILE_NAME, HOSTILE_NAME, Buffer.from("hostile")],
      ] as const) {
        await expect(
          downloadAndWait(
            { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/${remote}` },
            context(),
          ),
        ).resolves.toMatchObject({ ok: true, fileName });
        expect(Buffer.compare(await readFile(path.join(workspace, fileName)), content)).toBe(0);
      }
      await expectNoInjection();
    });

    it("never overwrites an existing workspace file and does not start ssh", async () => {
      await writeFile(path.join(workspace, "big.bin"), "mine");
      await expect(
        downloadAndWait(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/big.bin` },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "exists" });
      await expect(readFile(path.join(workspace, "big.bin"), "utf8")).resolves.toBe("mine");
      expect(await spawnedArgv()).toEqual([]);
    });

    it("does not write through a link planted at the destination", async () => {
      const victim = path.join(sandbox, "victim.txt");
      await writeFile(victim, "victim");
      await symlink(victim, path.join(workspace, "empty.txt"));
      await expect(
        downloadAndWait(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/empty.txt` },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "exists" });
      await expect(readFile(victim, "utf8")).resolves.toBe("victim");
    });

    it("removes the empty local file when the remote path is not a regular file", async () => {
      await expect(
        downloadAndWait(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/docs` },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "not-a-file" });
      await expect(
        downloadAndWait(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/missing.txt` },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "not-found" });
      expect((await readdir(workspace)).sort()).toEqual(["big-up.bin", "report.txt", "sub"]);
    });

    it.each(["/", "/..", "/a/.."])(
      "refuses the remote path %j as a file name",
      async (remotePath) => {
        await expect(
          downloadAndWait({ target: TARGET, workspaceId: "w1", remotePath }, context()),
        ).resolves.toMatchObject({ ok: false, code: "invalid" });
      },
    );
  });

  describe("upload", () => {
    it("copies a workspace file to the remote directory", async () => {
      const result = await uploadAndWait(
        {
          target: TARGET,
          workspaceId: "w1",
          localPath: "sub/inner.txt",
          remoteDirectory: `${remoteHome}/docs`,
        },
        context(),
      );
      expect(result).toEqual({
        ok: true,
        remotePath: path.join(remoteHome, "docs", "inner.txt"),
        size: 10,
      });
      await expect(readFile(path.join(remoteHome, "docs", "inner.txt"), "utf8")).resolves.toBe(
        "inner body",
      );
    });

    it("copies a multi-chunk file byte for byte", async () => {
      await uploadAndWait(
        { target: TARGET, workspaceId: "w1", localPath: "big-up.bin", remoteDirectory: remoteHome },
        context(),
      );
      expect(Buffer.compare(await readFile(path.join(remoteHome, "big-up.bin")), big)).toBe(0);
    });

    it("never overwrites an existing remote file", async () => {
      await writeFile(path.join(remoteHome, "report.txt"), "remote original");
      await expect(
        uploadAndWait(
          {
            target: TARGET,
            workspaceId: "w1",
            localPath: "report.txt",
            remoteDirectory: remoteHome,
          },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "exists" });
      await expect(readFile(path.join(remoteHome, "report.txt"), "utf8")).resolves.toBe(
        "remote original",
      );
    });

    it("refuses local paths that leave the workspace directory", async () => {
      await symlink(path.join(remoteHome, "empty.txt"), path.join(workspace, "linked.txt"));
      await writeFile(path.join(sandbox, "outside.txt"), "outside");
      for (const localPath of ["linked.txt", "../outside.txt", path.join(sandbox, "outside.txt")]) {
        await expect(
          uploadAndWait(
            { target: TARGET, workspaceId: "w1", localPath, remoteDirectory: remoteHome },
            context(),
          ),
        ).resolves.toMatchObject({ ok: false, code: "invalid" });
      }
      expect(existsSync(path.join(remoteHome, "outside.txt"))).toBe(false);
      expect(existsSync(path.join(remoteHome, "linked.txt"))).toBe(false);
    });

    it("refuses a remote destination that is a file or missing", async () => {
      await expect(
        uploadAndWait(
          {
            target: TARGET,
            workspaceId: "w1",
            localPath: "report.txt",
            remoteDirectory: `${remoteHome}/big.bin`,
          },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "not-a-directory" });
      await expect(
        uploadAndWait(
          {
            target: TARGET,
            workspaceId: "w1",
            localPath: "report.txt",
            remoteDirectory: `${remoteHome}/missing`,
          },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "not-found" });
    });
  });

  describe("transfers", { timeout: 20_000 }, () => {
    const GIB = 1024 ** 3;

    function download(remote: string) {
      return startDownload(
        { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/${remote}` },
        context(),
      );
    }

    it("returns a transfer id at once and reports progress up to the full size", async () => {
      process.env.FAKE_SSH_THROTTLE_MS = "60";
      const started = await download("big.bin");
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const running = transferStatus({ transferId: started.transferId });
      expect(running).toMatchObject({ ok: true, transfer: { state: "running", kind: "download" } });
      const midway = await waitFor(started.transferId, progressOrEnded);
      expect(midway.total).toBe(big.length);
      const finished = await waitFor(started.transferId, isEnded);
      expect(finished).toMatchObject({ state: "done", bytesDone: big.length, total: big.length });
    });

    it("cancels a download, removes the partial file, and ends cancelled", async () => {
      process.env.FAKE_SSH_THROTTLE_MS = "100";
      const started = await download("big.bin");
      if (!started.ok) throw new Error(started.message);
      await waitFor(started.transferId, hasProgress);
      expect(cancelTransfer({ transferId: started.transferId })).toEqual({ ok: true });
      const ended = await waitFor(started.transferId, isEnded);
      expect(ended).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
      expect(ended.bytesDone).toBeLessThan(big.length);
      expect(existsSync(path.join(workspace, "big.bin"))).toBe(false);
    });

    it("cancels an upload and removes the partial remote file", async () => {
      process.env.FAKE_SSH_THROTTLE_MS = "100";
      const started = await startUpload(
        { target: TARGET, workspaceId: "w1", localPath: "big-up.bin", remoteDirectory: remoteHome },
        context(),
      );
      if (!started.ok) throw new Error(started.message);
      await waitFor(started.transferId, hasProgress);
      cancelTransfer({ transferId: started.transferId });
      const ended = await waitFor(started.transferId, isEnded);
      expect(ended.state).toBe("cancelled");
      expect(existsSync(path.join(remoteHome, "big-up.bin"))).toBe(false);
    });

    it("answers unknown transfer ids with not-found", () => {
      expect(transferStatus({ transferId: "nope" })).toMatchObject({
        ok: false,
        code: "not-found",
      });
      expect(cancelTransfer({ transferId: "nope" })).toMatchObject({
        ok: false,
        code: "not-found",
      });
    });

    it("refuses a download over 2 GiB and leaves no local file", async () => {
      const huge = path.join(remoteHome, "huge.bin");
      await writeFile(huge, "");
      await truncate(huge, 2 * GIB + 1);
      await expect(
        downloadAndWait({ target: TARGET, workspaceId: "w1", remotePath: huge }, context()),
      ).resolves.toMatchObject({ ok: false, code: "too-large" });
      expect(existsSync(path.join(workspace, "huge.bin"))).toBe(false);
    });

    it("refuses an upload over 2 GiB before starting ssh", async () => {
      const huge = path.join(workspace, "huge.bin");
      await writeFile(huge, "");
      await truncate(huge, 2 * GIB + 1);
      await expect(
        startUpload(
          { target: TARGET, workspaceId: "w1", localPath: "huge.bin", remoteDirectory: remoteHome },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "too-large" });
      expect(await spawnedArgv()).toEqual([]);
    });

    it("fails a download when the server reports no size, and removes the empty file", async () => {
      process.env.FAKE_SSH_HOSTILE = path.join(sandbox, "bin", "hostile.js");
      await expect(
        downloadAndWait(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/empty.txt` },
          context(),
        ),
      ).resolves.toMatchObject({
        ok: false,
        code: "failed",
        message: expect.stringContaining("size"),
      });
      expect(existsSync(path.join(workspace, "empty.txt"))).toBe(false);
    });

    it("allows four transfers at once and answers the fifth with busy", async () => {
      for (const name of NAMES) await writeFile(path.join(remoteHome, name), name);
      const results = await Promise.all(NAMES.map(download));
      expect(failures(results)).toEqual([expect.objectContaining({ code: "busy" })]);
      for (const result of successes(results)) {
        if (result.ok) await waitFor(result.transferId, isEnded);
      }
    });

    it("allows four listings at once and answers the fifth with busy", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, listOnce));
      expect(successes(results)).toHaveLength(4);
      expect(failures(results)).toEqual([expect.objectContaining({ code: "busy" })]);
    });

    it("keeps only a bounded number of finished transfers", async () => {
      const ids: string[] = [];
      for (let index = 0; index < MAX_FINISHED_TRANSFERS + 10; index += 1) {
        await writeFile(path.join(remoteHome, `r${index}`), "x");
        const started = await download(`r${index}`);
        if (!started.ok) throw new Error(started.message);
        ids.push(started.transferId);
        await waitFor(started.transferId, isEnded);
      }
      expect(transferStatus({ transferId: ids[0] })).toMatchObject({
        ok: false,
        code: "not-found",
      });
      expect(transferStatus({ transferId: ids.at(-1)! })).toMatchObject({ ok: true });
    });
  });
});
