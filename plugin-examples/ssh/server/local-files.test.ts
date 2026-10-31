import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDownloadTarget, describeErrno, openDeviceUpload } from "./local-files";

let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "ssh-local-files-")));
  root = path.join(sandbox, "ws");
  outside = path.join(sandbox, "outside");
  await mkdir(path.join(root, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "a.txt"), "inside");
  await writeFile(path.join(root, "sub", "b.txt"), "nested");
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(outside, path.join(root, "link-out"));
  await symlink(path.join(outside, "secret.txt"), path.join(root, "file-link-out"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("describeErrno", () => {
  it.each([
    ["ENOSPC", "failed", "disk is full"],
    ["EDQUOT", "failed", "disk is full"],
    ["ENAMETOOLONG", "invalid", "too long"],
    ["EACCES", "permission", "Permission denied"],
    ["EPERM", "permission", "Permission denied"],
    ["EROFS", "permission", "read-only"],
    ["EEXIST", "exists", "already exists"],
    ["ENOENT", "not-found", "no longer exists"],
  ])("explains %s in plain words", (errno, code, phrase) => {
    expect(describeErrno(errno)).toMatchObject({ code, message: expect.stringContaining(phrase) });
  });

  it("leaves other errors to the caller", () => {
    expect(describeErrno("EIO")).toBeNull();
    expect(describeErrno(undefined)).toBeNull();
  });
});

describe("openDeviceUpload", () => {
  it("opens the regular file the daemon resolved and reports its name and size", async () => {
    const source = await openDeviceUpload(path.join(root, "sub", "b.txt"));
    try {
      expect(source).toMatchObject({ name: "b.txt", size: 6 });
    } finally {
      await source.handle.close();
    }
  });

  it.each([
    ["a file link out of its folder", () => path.join(root, "file-link-out"), "invalid"],
    ["a file link that stays in its folder", () => path.join(root, "a-link.txt"), "invalid"],
    [
      "a file inside a folder that is a link",
      () => path.join(root, "link-out", "secret.txt"),
      "invalid",
    ],
    ["a directory", () => path.join(root, "sub"), "not-a-file"],
    ["a missing file", () => path.join(root, "gone.txt"), "not-found"],
    ["a name with a backslash", () => path.join(root, "a\\b.txt"), "invalid"],
  ])("refuses %s", async (_name, filePath, code) => {
    await symlink("a.txt", path.join(root, "a-link.txt"));
    await expect(openDeviceUpload(filePath())).rejects.toMatchObject({ code });
  });
});

describe("createDownloadTarget", () => {
  it("creates a new private file inside the root", async () => {
    const { handle, filePath } = await createDownloadTarget(root, "new.txt");
    await handle.close();
    expect(filePath).toBe(path.join(root, "new.txt"));
  });

  it("never overwrites an existing file", async () => {
    await expect(createDownloadTarget(root, "a.txt")).rejects.toMatchObject({ code: "exists" });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("inside");
  });

  it("does not follow an existing link out of the root", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "planted.txt"));
    await expect(createDownloadTarget(root, "planted.txt")).rejects.toMatchObject({
      code: "exists",
    });
    await expect(readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe("secret");
  });

  it.each(["../escape.txt", "sub/escape.txt", "..", "a\\b", ""])(
    "refuses the remote name %j",
    async (name) => {
      await expect(createDownloadTarget(root, name)).rejects.toMatchObject({ code: "invalid" });
    },
  );
});
