const WHITESPACE = /\s/;

/** True for C0 control characters and DEL. */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface SshConnectionTarget {
  /** A Host alias from ~/.ssh/config, or a hostname/address for a user-added host. */
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export interface SshInvocation {
  command: "ssh";
  args: string[];
}

/**
 * Returns a reason when `value` could be read by ssh as an option or split into several words,
 * otherwise `null`. Every value reaches ssh as one argv element, never through a shell.
 */
export function describeUnsafeValue(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.startsWith("-")) return "must not start with '-'";
  if (WHITESPACE.test(value) || hasControlCharacter(value))
    return "must not contain whitespace or control characters";
  return null;
}

/** Like `describeUnsafeValue`, but allows spaces because a path is one argv element. */
export function describeUnsafePath(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.startsWith("-")) return "must not start with '-'";
  if (hasControlCharacter(value)) return "must not contain control characters";
  return null;
}

function requireSafe(field: string, value: string): string {
  const reason = describeUnsafeValue(value);
  if (reason) throw new Error(`Invalid SSH ${field}: ${reason}`);
  return value;
}

export interface SshInvocationExtras {
  /** Fixed `-o key=value` options placed first. These come from code, never from a user. */
  options?: readonly string[];
  /** Runs this subsystem (`ssh -s`) instead of a login shell. */
  subsystem?: string;
}

/**
 * Builds the argv for `ssh`. The `--` stops option parsing before the destination; a subsystem
 * name follows the destination as the remote command.
 */
export function buildSshInvocation(
  target: SshConnectionTarget,
  extras: SshInvocationExtras = {},
): SshInvocation {
  const host = requireSafe("host", target.host);
  const args: string[] = [];
  for (const option of extras.options ?? []) args.push("-o", option);
  if (target.port !== undefined) {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new Error("Invalid SSH port: must be an integer from 1 to 65535");
    }
    args.push("-p", String(target.port));
  }
  if (target.identityFile) {
    const reason = describeUnsafePath(target.identityFile);
    if (reason) throw new Error(`Invalid SSH identity file: ${reason}`);
    args.push("-i", target.identityFile);
  }
  if (target.user) args.push("-l", requireSafe("user", target.user));
  if (extras.subsystem) args.push("-s");
  args.push("--", host);
  if (extras.subsystem) args.push(extras.subsystem);
  return { command: "ssh", args };
}
