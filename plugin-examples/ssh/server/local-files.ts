import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FileErrorCode } from "../shared/contracts";
import { describeUnsafeFileName } from "../shared/remote-path";
import { FileOpError } from "./ssh-transport";

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
  /** The name the file gets on the remote side: the uploaded file's name. */
  name: string;
  size: number;
  mode: number;
}

/**
 * Opens a device upload the daemon resolved (`resolveDeviceUpload`) for reading. It opens that
 * exact path with `O_NOFOLLOW`, so a final symlink swapped in after the daemon's check is refused,
 * and requires a regular file. After the open, the folder must still resolve to itself and the
 * name must still be the opened file (device and inode), so a folder swapped for a link between
 * the daemon's check and this open is refused too.
 */
export async function openDeviceUpload(filePath: string): Promise<UploadSource> {
  const name = path.basename(filePath);
  const nameProblem = describeUnsafeFileName(name);
  if (nameProblem) throw new FileOpError("invalid", `The file name ${nameProblem}.`);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new FileOpError("invalid", "Only regular files can be uploaded, not links.");
      }
      throw fsError(error, "Could not open the file");
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileOpError("not-a-file", "Only regular files can be uploaded.");
    const directory = path.dirname(filePath);
    const [realDirectory, current] = await Promise.all([
      realpath(directory).catch(() => null),
      lstat(filePath).catch(() => null),
    ]);
    if (realDirectory !== directory || current?.dev !== info.dev || current?.ino !== info.ino) {
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
