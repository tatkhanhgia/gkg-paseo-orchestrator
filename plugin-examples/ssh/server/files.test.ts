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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadFile, listRemoteFiles, listWorkspaceFiles, uploadFile } from "./files";

const SFTP_SERVER = [
  "/usr/libexec/sftp-server",
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
].find((candidate) => existsSync(candidate));

const HOSTILE_NAME = `-rf "q"; $(touch PWNED) '!x'.txt`;
type Listing = { ok: true; entries: { name: string }[] } | { ok: false };

function entriesByName<Entry extends { name: string }>(entries: Entry[]): Record<string, Entry> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
}

function entryNames(result: Listing): string[] {
  return result.ok ? result.entries.map((entry) => entry.name) : [];
}

const TARGET = { host: "build-box", user: "deploy", port: 2222 };

// These tests run the real handlers. `ssh` on PATH is a script that records its argv and then
// serves the real OpenSSH `sftp-server` over stdio, so the SFTP bytes, the spawn, and the file
// systems on both sides are real. Only the network hop is replaced.
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
        `exec ${SFTP_SERVER} -d "$FAKE_SFTP_HOME"`,
      ].join("\n"),
    );
    await chmod(path.join(bin, "ssh"), 0o755);
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
      const result = await downloadFile(
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
          downloadFile(
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
        downloadFile(
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
        downloadFile(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/empty.txt` },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "exists" });
      await expect(readFile(victim, "utf8")).resolves.toBe("victim");
    });

    it("removes the empty local file when the remote path is not a regular file", async () => {
      await expect(
        downloadFile(
          { target: TARGET, workspaceId: "w1", remotePath: `${remoteHome}/docs` },
          context(),
        ),
      ).resolves.toMatchObject({ ok: false, code: "not-a-file" });
      await expect(
        downloadFile(
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
          downloadFile({ target: TARGET, workspaceId: "w1", remotePath }, context()),
        ).resolves.toMatchObject({ ok: false, code: "invalid" });
      },
    );
  });

  describe("upload", () => {
    it("copies a workspace file to the remote directory", async () => {
      const result = await uploadFile(
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
      await uploadFile(
        { target: TARGET, workspaceId: "w1", localPath: "big-up.bin", remoteDirectory: remoteHome },
        context(),
      );
      expect(Buffer.compare(await readFile(path.join(remoteHome, "big-up.bin")), big)).toBe(0);
    });

    it("never overwrites an existing remote file", async () => {
      await writeFile(path.join(remoteHome, "report.txt"), "remote original");
      await expect(
        uploadFile(
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
          uploadFile(
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
        uploadFile(
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
        uploadFile(
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
});
