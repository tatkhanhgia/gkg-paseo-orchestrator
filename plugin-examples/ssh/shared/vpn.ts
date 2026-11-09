import type { SshInvocation } from "./ssh-args";

/** How the plugin asks the shared on-demand VPN script to hold a tunnel open around a command. */
export interface VpnProfile {
  /** The shared `vpn_session.sh`; run as `bash <script> exec ...`. */
  script: string;
  openvpnPath: string;
  config: string;
  managementSocket: string;
}

/** The default ssh port, probed when a host has none of its own. */
export const DEFAULT_SSH_PORT = 22;

/** Diagnostic lines the script writes to stderr start with this prefix. */
export const VPN_DIAGNOSTIC_PREFIX = "gkg-vpn:";

/**
 * `bash <script> exec <openvpn> <config> <socket> <probeHost> <probePort> -- <command> <args>`.
 * The script takes a lease for its own pid, waits until the probe target answers, then `exec`s the
 * command, so the lease lives exactly as long as the command does. Every element is an argv
 * element; nothing goes through a shell string.
 */
export function wrapWithVpn(
  profile: VpnProfile,
  probe: { host: string; port: number },
  inner: { command: string; args: readonly string[] },
): SshInvocation {
  return {
    command: "bash",
    args: [
      profile.script,
      "exec",
      profile.openvpnPath,
      profile.config,
      profile.managementSocket,
      probe.host,
      String(probe.port),
      "--",
      inner.command,
      ...inner.args,
    ],
  };
}

/** Opens the tunnel and releases it at once; the script's grace period keeps it up afterwards. */
export function vpnPreflightInvocation(
  profile: VpnProfile,
  probe: { host: string; port: number },
): SshInvocation {
  return wrapWithVpn(profile, probe, { command: "true", args: [] });
}

/** Splits process stderr into the script's `gkg-vpn:` lines and everything else. */
export function splitVpnDiagnostics(stderr: string): { vpn: string; rest: string } {
  const vpn: string[] = [];
  const rest: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    (line.startsWith(VPN_DIAGNOSTIC_PREFIX) ? vpn : rest).push(line);
  }
  return { vpn: vpn.join("\n"), rest: rest.join("\n") };
}
