import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FileErrorCode } from "../shared/contracts";
import { describeUnsafeFileName } from "../shared/remote-path";
import { FileOpError } from "./ssh-transport";

/** Splits a `/`-relative path into segments and refuses anything that could leave the root. */
function relativeSegments(relative: string): string[] {
  if (relative.includes("\0")) throw new FileOpError("invalid", "The path contains a NUL byte.");
  if (relative.startsWith("/") || path.isAbsolute(relative) || relative.includes("\\")) {
    throw new FileOpError("invalid", "The path must be relative to its folder.");
  }
  const segments = relative.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new FileOpError("invalid", "The path must not contain '..'.");
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))
  );
}

/**
 * Resolves an existing path under `root` and returns its real path. Every symlink on the way is
 * followed first, then the result must still be inside `root`, so neither `..` nor a link that
 * points elsewhere can reach outside it. `root` must itself be a real path.
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const joined = path.join(root, ...relativeSegments(relative));
  let resolved: string;
  try {
    resolved = await realpath(joined);
  } catch {
    throw new FileOpError("not-found", "That file no longer exists on the daemon host.");
  }
  if (!isInside(root, resolved)) {
    throw new FileOpError("invalid", "That path resolves outside its folder.");
  }
  return resolved;
}

/** Plain-language outcome for the filesystem errors a person can act on, or `null` for others. */
export function describeErrno(code: string | undefined): FileOpErrorInfo | null {
  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
      return {
        code: "failed",
        message: "The disk is full or over its quota. Free some space and try again.",
      };
    case "ENAMETOOLONG":
      return { code: "invalid", message: "The file name or path is too long for this system." };
    case "EACCES":
    case "EPERM":
      return {
        code: "permission",
        message: "Permission denied. Check the folder's permissions on the daemon host.",
      };
    case "EROFS":
      return { code: "permission", message: "That location is read-only." };
    case "EEXIST":
      return { code: "exists", message: "A file with that name already exists." };
    case "ENOENT":
      return { code: "not-found", message: "That file or folder no longer exists." };
    default:
      return null;
  }
}

export interface FileOpErrorInfo {
  code: FileErrorCode;
  message: string;
}

function fsError(error: unknown, fallback: string): FileOpError {
  const code = (error as NodeJS.ErrnoException).code;
  const known = describeErrno(code);
  return known
    ? new FileOpError(known.code, known.message)
    : new FileOpError("failed", `${fallback}${code ? ` (${code})` : ""}`);
}

export interface UploadSource {
  handle: FileHandle;
  /** The name the file gets on the remote side: the last segment of the requested path. */
  name: string;
  size: number;
  mode: number;
}

/**
 * Opens a regular file under `root` for reading. The path is resolved and confined first, then
 * opened without following a final symlink. A parent directory could still be swapped for a
 * link between those two steps, so the open file is then compared with a fresh resolution of the
 * path: it must still be inside `root` and be the same file (device and inode).
 */
export async function openUploadSource(root: string, relative: string): Promise<UploadSource> {
  const segments = relativeSegments(relative);
  const name = segments.at(-1);
  if (!name) throw new FileOpError("invalid", "Choose a file to upload.");
  const nameProblem = describeUnsafeFileName(name);
  if (nameProblem) throw new FileOpError("invalid", `The file name ${nameProblem}.`);
  const resolved = await resolveInside(root, relative);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: unknown) => {
      throw fsError(error, "Could not open the file");
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileOpError("not-a-file", "Only regular files can be uploaded.");
    const fresh = await resolveInside(root, relative);
    const freshInfo = await stat(fresh);
    if (freshInfo.dev !== info.dev || freshInfo.ino !== info.ino) {
      throw new FileOpError("invalid", "The file changed while it was being opened. Try again.");
    }
    return { handle, name, size: info.size, mode: info.mode & 0o777 };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Creates `name` directly inside `root` and fails if anything exists there. `wx` is
 * `O_CREAT | O_EXCL`, which also refuses a pre-existing symlink, so an existing file is never
 * overwritten and a link is never followed. The file is private to the daemon user.
 */
export async function createDownloadTarget(
  root: string,
  name: string,
): Promise<{ handle: FileHandle; filePath: string }> {
  const problem = describeUnsafeFileName(name);
  if (problem) throw new FileOpError("invalid", `The remote file name ${problem}.`);
  const filePath = path.join(root, name);
  try {
    return { handle: await open(filePath, "wx", 0o600), filePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileOpError(
        "exists",
        `"${name}" already exists in the download folder. Nothing was changed.`,
      );
    }
    throw fsError(error, `Could not create "${name}" on the daemon host`);
  }
}
