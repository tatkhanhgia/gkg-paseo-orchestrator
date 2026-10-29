import { hasControlCharacter } from "./ssh-args";

export const MAX_REMOTE_PATH_LENGTH = 4096;

/**
 * Returns a reason when `value` cannot be sent as an SFTP path. SFTP carries a path as a
 * length-prefixed byte string, so quotes, newlines, and a leading `-` or `!` have no special
 * meaning; only an empty path, an oversized path, and NUL (which C servers treat as the end of
 * the string) are refused.
 */
export function describeInvalidRemotePath(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.length > MAX_REMOTE_PATH_LENGTH) return "is too long";
  if (value.includes("\0")) return "must not contain NUL";
  return null;
}

/**
 * Returns a reason when `name` cannot be one entry of a remote directory: it must not be empty,
 * `.` or `..`, or hold `/` or NUL. Any other byte, including a backslash or a newline, is a legal
 * remote file name and travels as data.
 */
export function describeInvalidRemoteName(name: string): string | null {
  if (name.length === 0) return "must not be empty";
  if (name === "." || name === "..") return "must not be '.' or '..'";
  if (name.includes("/") || name.includes("\0")) return "must not contain '/' or NUL";
  return null;
}

/**
 * Stricter than `describeInvalidRemoteName`: also refuses a backslash and control characters, so
 * the name is one plain file name on any local platform. Used for names written on the daemon host.
 */
export function describeUnsafeFileName(name: string): string | null {
  const reason = describeInvalidRemoteName(name);
  if (reason) return reason;
  if (name.includes("\\")) return "must not contain a backslash";
  if (hasControlCharacter(name)) return "must not contain control characters";
  return null;
}

/** Last segment of a `/`-separated remote path. */
export function remoteBasename(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Parent of a `/`-separated remote path, or `null` at the root or for a bare name. */
export function remoteParent(remotePath: string): string | null {
  const trimmed = remotePath.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return null;
  return slash === 0 ? "/" : trimmed.slice(0, slash);
}

/** Appends one plain file name to a remote directory path. Throws when the name is unsafe. */
export function remoteJoin(directory: string, name: string): string {
  const reason = describeInvalidRemoteName(name);
  if (reason) throw new Error(`Invalid file name: ${reason}`);
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}
