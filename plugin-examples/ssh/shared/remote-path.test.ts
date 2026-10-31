import { describe, expect, it } from "vitest";
import {
  describeInvalidRemotePath,
  describeUnsafeFileName,
  MAX_REMOTE_PATH_LENGTH,
  remoteBasename,
  remoteJoin,
  remoteParent,
} from "./remote-path";

describe("describeInvalidRemotePath", () => {
  it.each([
    ["an empty path", "", "must not be empty"],
    ["a NUL byte", "/home/a\0b", "must not contain NUL"],
    ["a path over the limit", `/${"a".repeat(MAX_REMOTE_PATH_LENGTH)}`, "is too long"],
  ])("rejects %s", (_name, value, reason) => {
    expect(describeInvalidRemotePath(value)).toBe(reason);
  });

  // SFTP sends a path as a length-prefixed string, so characters that would be dangerous in a
  // shell command or a batch file are ordinary data here and must stay usable.
  it.each([
    "-rf",
    "!ls",
    '/tmp/"quoted"',
    "/tmp/it's",
    "/tmp/$(id)",
    "/tmp/a;b`c`",
    "/tmp/line\nbreak",
    "/tmp/with space",
    "relative/dir",
  ])("accepts %j as data", (value) => {
    expect(describeInvalidRemotePath(value)).toBeNull();
  });
});

describe("describeUnsafeFileName", () => {
  it.each([
    ["", "must not be empty"],
    [".", "must not be '.' or '..'"],
    ["..", "must not be '.' or '..'"],
    ["a/b", "must not contain '/' or NUL"],
    ["a\0b", "must not contain '/' or NUL"],
    ["a\\b", "must not contain a backslash"],
    ["a\nb", "must not contain control characters"],
  ])("rejects %j", (name, reason) => {
    expect(describeUnsafeFileName(name)).toBe(reason);
  });

  it.each(["report.txt", "-rf", "'quoted'", "...", "..hidden", "a b"])("accepts %j", (name) => {
    expect(describeUnsafeFileName(name)).toBeNull();
  });
});

describe("remote path joining", () => {
  it.each([
    ["/home/me", "a.txt", "/home/me/a.txt"],
    ["/", "a.txt", "/a.txt"],
    ["/home/me/", "a.txt", "/home/me/a.txt"],
  ])("joins %s and %s", (directory, name, expected) => {
    expect(remoteJoin(directory, name)).toBe(expected);
  });

  it.each(["", ".", "..", "x/y"])("refuses to join the name %j", (name) => {
    expect(() => remoteJoin("/home/me", name)).toThrow(/Invalid file name/);
  });

  it.each([
    ["/home/me/a.txt", "/home/me", "a.txt"],
    ["/a", "/", "a"],
    ["/", null, ""],
    ["/home/me/dir/", "/home/me", "dir"],
    ["plain", null, "plain"],
  ])("splits %s into parent and basename", (value, parent, base) => {
    expect(remoteParent(value)).toBe(parent);
    expect(remoteBasename(value)).toBe(base);
  });
});
