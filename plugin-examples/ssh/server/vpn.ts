import { spawn, type ChildProcess } from "node:child_process";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { hostsSettings, SshVpnProfile } from "../shared/contracts";
import { CANCELLED_MESSAGE } from "../shared/transfer-messages";
import {
  DEFAULT_SSH_PORT,
  splitVpnDiagnostics,
  vpnPreflightInvocation,
  wrapWithVpn,
} from "../shared/vpn";
import {
  describeUnsafeValue,
  summarizeText,
  type SshConnectionTarget,
  type SshInvocation,
} from "../shared/ssh-args";

/** Below the 60 s limit on a plugin RPC, so a cold VPN start can still report its failure. */
export const VPN_PREFLIGHT_TIMEOUT_MS = 45_000;
const MAX_STDERR_CHARS = 8192;
const KILL_GRACE_MS = 2000;

/** A VPN step failed. `code` is the file-operation failure class it maps to. */
export class VpnError extends Error {
  constructor(
    readonly code: "invalid" | "connect" | "cancelled",
    message: string,
  ) {
    super(message);
  }
}

export interface PreparedVpn {
  /** The command a terminal or SFTP process runs: `ssh` behind the VPN script's `exec`. */
  wrap(inner: SshInvocation): SshInvocation;
}

type SettingsSource = Pick<PluginSettings<(typeof hostsSettings)["schema"]>, "read">;

let settingsSource: SettingsSource | null = null;
const preflights = new Set<ChildProcess>();

/** Gives this module the plugin's settings, where the VPN profiles live. Called once at startup. */
export function configureVpn(source: SettingsSource): void {
  settingsSource = source;
}

async function findProfile(name: string): Promise<SshVpnProfile> {
  if (!settingsSource) throw new VpnError("invalid", "The SSH plugin settings are not available.");
  const state = await settingsSource.read();
  if (state.status !== "ready") {
    throw new VpnError(
      "invalid",
      `The SSH plugin settings could not be read, so VPN "${name}" cannot be opened: ${state.error}`,
    );
  }
  const profile = state.values.vpnProfiles.find((candidate) => candidate.name === name);
  if (!profile) {
    throw new VpnError(
      "invalid",
      `VPN profile "${name}" is not defined in the SSH plugin settings. Add it under VPN profiles, or pick another for this host.`,
    );
  }
  return profile;
}

function stop(child: ChildProcess): void {
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref();
}

/** Runs the preflight: `exec ... -- true`. Resolves once the tunnel answers, rejects otherwise. */
function runPreflight(
  profileName: string,
  invocation: SshInvocation,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new VpnError("cancelled", CANCELLED_MESSAGE));
      return;
    }
    // stdout is ignored: the script writes nothing there. stderr carries `gkg-vpn:` diagnostics.
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    preflights.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
    });
    let outcome: "timeout" | "cancelled" | null = null;
    const timer = setTimeout(() => {
      outcome = "timeout";
      stop(child);
    }, options.timeoutMs);
    const onAbort = () => {
      outcome = "cancelled";
      stop(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (error: VpnError | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      preflights.delete(child);
      if (error) reject(error);
      else resolve();
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        new VpnError(
          "connect",
          error.code === "ENOENT"
            ? "bash was not found on the daemon host, so the VPN cannot be opened."
            : `Could not start the VPN script: ${error.message}`,
        ),
      );
    });
    child.on("close", (exitCode) => {
      if (outcome === "cancelled") return finish(new VpnError("cancelled", CANCELLED_MESSAGE));
      if (outcome === "timeout") {
        const seconds = Math.round(options.timeoutMs / 1000);
        return finish(
          new VpnError("connect", `VPN "${profileName}" did not come up within ${seconds} s.`),
        );
      }
      if (exitCode === 0) return finish(null);
      const { vpn, rest } = splitVpnDiagnostics(stderr);
      const detail = summarizeText(vpn || rest) || `exit code ${exitCode ?? "unknown"}`;
      return finish(new VpnError("connect", `Could not open VPN "${profileName}": ${detail}`));
    });
  });
}

/**
 * When `target` names a VPN profile, opens that VPN and returns how to run a command behind it;
 * otherwise returns `null`. The profile comes from the plugin settings, never from the client, and
 * the probe target is the host's own address and port. The preflight takes and releases a lease
 * while it waits, so a cold start is paid here, before any session or file-operation timer starts;
 * the wrapped command then joins the open tunnel at once and holds its own lease for as long as it
 * runs. Nothing here closes the VPN: the script does, a grace period after the last lease ends.
 */
export async function prepareVpn(
  target: SshConnectionTarget,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PreparedVpn | null> {
  if (!target.vpnProfile) return null;
  const reason = describeUnsafeValue(target.host);
  if (reason) throw new VpnError("invalid", `Invalid SSH host: ${reason}`);
  const profile = await findProfile(target.vpnProfile);
  const probe = { host: target.host, port: target.port ?? DEFAULT_SSH_PORT };
  await runPreflight(profile.name, vpnPreflightInvocation(profile, probe), {
    timeoutMs: options.timeoutMs ?? VPN_PREFLIGHT_TIMEOUT_MS,
    signal: options.signal,
  });
  return { wrap: (inner) => wrapWithVpn(profile, probe, inner) };
}

/** Plugin teardown: ends preflights still waiting for a tunnel. Their leases die with them. */
export function stopVpnPreflights(): void {
  for (const child of preflights) stop(child);
}
