import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDownloadTarget,
  listWorkspaceDirectory,
  openUploadSource,
  resolveInside,
} from "./local-files";

let sandbox: string;
let root: string;
let outside: string;
let evilSibling: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "ssh-local-files-")));
  root = path.join(sandbox, "ws");
  outside = path.join(sandbox, "outside");
  // Shares the prefix "ws", which a naive startsWith(root) containment check would accept.
  evilSibling = path.join(sandbox, "ws-evil");
  await mkdir(path.join(root, "sub"), { recursive: true });
  await mkdir(outside);
  await mkdir(evilSibling);
  await writeFile(path.join(root, "a.txt"), "inside");
  await writeFile(path.join(root, "sub", "b.txt"), "nested");
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await writeFile(path.join(evilSibling, "secret.txt"), "secret");
  await symlink("sub", path.join(root, "link-in"));
  await symlink(outside, path.join(root, "link-out"));
  await symlink(path.join(outside, "secret.txt"), path.join(root, "file-link-out"));
  await symlink("../ws-evil", path.join(root, "link-evil"));
  await symlink("missing", path.join(root, "link-broken"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("resolveInside", () => {
  it.each([
    ["the root itself", "", ""],
    ["a nested file", "sub/b.txt", "sub/b.txt"],
    ["redundant separators", "sub//./b.txt", "sub/b.txt"],
    ["a link that stays inside", "link-in/b.txt", "sub/b.txt"],
  ])("resolves %s", async (_name, relative, expected) => {
    await expect(resolveInside(root, relative)).resolves.toBe(path.join(root, expected));
  });

  it.each([
    ["a parent segment", "../outside/secret.txt"],
    ["a parent segment in the middle", "sub/../../outside/secret.txt"],
    ["an absolute path", "/etc/hosts"],
    ["a backslash", "sub\\b.txt"],
    ["a NUL byte", "a.txt\0.png"],
    ["a directory link that leaves the root", "link-out/secret.txt"],
    ["a file link that leaves the root", "file-link-out"],
    ["a link into a sibling sharing the root's prefix", "link-evil/secret.txt"],
  ])("refuses %s", async (_name, relative) => {
    await expect(resolveInside(root, relative)).rejects.toMatchObject({ code: "invalid" });
  });

  it("reports a missing path as not found", async () => {
    await expect(resolveInside(root, "nope.txt")).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("listWorkspaceDirectory", () => {
  it("lists directories first and shows links by where they lead", async () => {
    const listing = await listWorkspaceDirectory(root, "");
    expect(listing.parent).toBeNull();
    const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));
    expect(listing.entries.map((entry) => entry.name).slice(0, 2)).toEqual(["link-in", "sub"]);
    expect(byName["a.txt"]).toMatchObject({ kind: "file", size: 6 });
    expect(byName["link-in"]).toMatchObject({ kind: "directory", size: null });
    // Links that leave the root or lead nowhere are not offered as files or directories.
    expect(byName["link-out"]).toMatchObject({ kind: "symlink", size: null });
    expect(byName["file-link-out"]).toMatchObject({ kind: "symlink", size: null });
    expect(byName["link-evil"]).toMatchObject({ kind: "symlink", size: null });
    expect(byName["link-broken"]).toMatchObject({ kind: "symlink", size: null });
  });

  it("reports the parent of a subdirectory", async () => {
    const listing = await listWorkspaceDirectory(root, "sub");
    expect(listing).toMatchObject({ directory: "sub", parent: "" });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["b.txt"]);
  });

  it("refuses to list a directory outside the root", async () => {
    await expect(listWorkspaceDirectory(root, "link-out")).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("openUploadSource", () => {
  it("opens a regular file and reports its size", async () => {
    const source = await openUploadSource(root, "sub/b.txt");
    try {
      expect(source).toMatchObject({ name: "b.txt", size: 6 });
    } finally {
      await source.handle.close();
    }
  });

  it.each([
    ["a file link that leaves the root", "file-link-out", "invalid"],
    ["a parent segment", "../outside/secret.txt", "invalid"],
    ["a directory", "sub", "not-a-file"],
    ["nothing", "", "invalid"],
  ])("refuses %s", async (_name, relative, code) => {
    await expect(openUploadSource(root, relative)).rejects.toMatchObject({ code });
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
