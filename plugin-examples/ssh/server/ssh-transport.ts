import { spawn, type ChildProcess } from "node:child_process";
import type { FileErrorCode } from "../shared/contracts";
import {
  buildSshInvocation,
  hasControlCharacter,
  type SshConnectionTarget,
} from "../shared/ssh-args";
import { SftpClient } from "./sftp-client";

/** A failure that already carries the code and message the panel shows. */
export class FileOpError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Options that keep file browsing non-interactive and unable to change trust. `BatchMode` makes a
 * password or passphrase prompt fail instead of waiting. `StrictHostKeyChecking=yes` on the
 * command line outranks the user's config, so an unknown or changed host key is refused and
 * nothing is written to known_hosts. The control options stop a configured master connection from
 * outliving this process, and the forwarding and local-command options stop config from running
 * anything beyond the SFTP session.
 */
export const SFTP_SSH_OPTIONS = [
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "UpdateHostKeys=no",
  "VerifyHostKeyDNS=no",
  "PasswordAuthentication=no",
  "KbdInteractiveAuthentication=no",
  "ControlMaster=no",
  "ControlPath=none",
  "ClearAllForwardings=yes",
  "PermitLocalCommand=no",
  "ForwardAgent=no",
  "ForwardX11=no",
  "RequestTTY=no",
  "RemoteCommand=none",
  "ConnectTimeout=10",
  "ServerAliveInterval=15",
  "ServerAliveCountMax=2",
  "LogLevel=ERROR",
] as const;

const MAX_STDERR_CHARS = 8192;
const MAX_MESSAGE_CHARS = 300;
const KILL_GRACE_MS = 2000;
const WATCHDOG_INTERVAL_MS = 5000;
/** A session with no bytes from the server for this long is considered stalled. */
const IDLE_TIMEOUT_MS = 60_000;
/** After a cancel, how long the transfer gets to remove its partial file before ssh is killed. */
const CANCEL_GRACE_MS = 10_000;

function summarize(stderr: string): string {
  const text = [...stderr]
    .map((char) => (hasControlCharacter(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

/** Maps what `ssh` printed to the code and message the panel shows. */
export function classifySshFailure(stderr: string): { code: FileErrorCode; message: string } {
  const text = summarize(stderr);
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(stderr)) {
    return {
      code: "host-key",
      message:
        "The host key changed since it was trusted. Check it before continuing; connect with the terminal to see the details.",
    };
  }
  if (/host key verification failed|no .* host key is known/i.test(stderr)) {
    return {
      code: "host-key",
      message:
        "This host's key is not trusted yet. Connect once with the terminal to accept it, then retry.",
    };
  }
  if (/permission denied|too many authentication failures/i.test(stderr)) {
    return {
      code: "auth",
      message: "This host needs a key or ssh-agent for file browsing; the terminal still works.",
    };
  }
  if (/subsystem request failed|subsystem .*not (found|available)/i.test(stderr)) {
    return { code: "subsystem", message: "The server does not offer the SFTP subsystem." };
  }
  if (
    /could not resolve|connection (refused|timed out|reset|closed)|no route to host|network is unreachable|operation timed out/i.test(
      stderr,
    )
  ) {
    return { code: "connect", message: `Could not connect: ${text}` };
  }
  return { code: "failed", message: text ? `ssh failed: ${text}` : "ssh failed" };
}

function terminate(child: ChildProcess): void {
  child.stdin?.end();
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref();
}

export interface SftpRunOptions {
  /** Hard limit for connecting plus `run`. */
  timeoutMs: number;
  /** When aborted, `run` should stop and clean up; ssh is killed if it has not after a grace period. */
  signal?: AbortSignal;
}

/**
 * Starts `ssh -s sftp` for `target`, runs `run` against the session, and always stops the
 * process it started. `ssh` runs from an argv array, never through a shell.
 */
export async function withSftp<T>(
  target: SshConnectionTarget,
  options: SftpRunOptions,
  run: (client: SftpClient) => Promise<T>,
): Promise<T> {
  let invocation;
  try {
    invocation = buildSshInvocation(target, { options: SFTP_SSH_OPTIONS, subsystem: "sftp" });
  } catch (error) {
    throw new FileOpError("invalid", error instanceof Error ? error.message : String(error));
  }

  const child = spawn(invocation.command, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
  });
  // A write to a dead process fails here; the real cause arrives with the process `close`.
  child.stdin.on("error", () => undefined);

  const client = new SftpClient(child.stdin, child.stdout);
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  child.stdout.on("data", () => {
    lastActivityAt = Date.now();
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    client.fail(
      new FileOpError(
        "failed",
        error.code === "ENOENT"
          ? "The ssh command was not found on the daemon host."
          : `Could not start ssh: ${error.message}`,
      ),
    );
  });
  child.on("close", (exitCode) => {
    const failure = classifySshFailure(stderr);
    client.fail(
      new FileOpError(
        failure.code,
        stderr.trim() ? failure.message : `ssh exited with code ${exitCode ?? "unknown"}`,
      ),
    );
  });
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - startedAt > options.timeoutMs) {
      client.fail(new FileOpError("timeout", "The file operation took too long and was stopped."));
      terminate(child);
    } else if (now - lastActivityAt > IDLE_TIMEOUT_MS) {
      client.fail(new FileOpError("timeout", "The server stopped responding."));
      terminate(child);
    }
  }, WATCHDOG_INTERVAL_MS);

  let graceTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    graceTimer = setTimeout(() => {
      client.fail(new FileOpError("cancelled", "The transfer was cancelled."));
      terminate(child);
    }, CANCEL_GRACE_MS);
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await client.init();
    return await run(client);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    clearTimeout(graceTimer);
    clearInterval(watchdog);
    terminate(child);
  }
}
