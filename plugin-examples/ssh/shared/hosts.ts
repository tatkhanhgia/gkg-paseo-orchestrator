import type { SshConfigHost, SshUserHost } from "./contracts";
import { sessionName } from "./sessions";
import { describeUnsafePath, describeUnsafeValue, type SshConnectionTarget } from "./ssh-args";

export interface SshHostEntry {
  key: string;
  label: string;
  detail: string;
  source: "config" | "user";
  /** Config hosts connect by alias so ssh applies its own config. */
  target: SshConnectionTarget;
}

function configEntry(host: SshConfigHost): SshHostEntry {
  const endpoint = [host.hostName, host.port ? `:${host.port}` : ""].join("");
  return {
    key: `config:${host.alias}`,
    label: host.alias,
    detail: [host.user ? `${host.user}@` : "", endpoint].join("") || "~/.ssh/config",
    source: "config",
    target: { host: host.alias },
  };
}

function userEntry(host: SshUserHost): SshHostEntry {
  const detail = `${host.user ? `${host.user}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
  return {
    key: `user:${host.id}`,
    label: host.label,
    detail,
    source: "user",
    target: {
      host: host.host,
      ...(host.user ? { user: host.user } : {}),
      ...(host.port ? { port: host.port } : {}),
      ...(host.identityFile ? { identityFile: host.identityFile } : {}),
    },
  };
}

export function toHostEntries(
  configHosts: readonly SshConfigHost[],
  userHosts: readonly SshUserHost[],
): SshHostEntry[] {
  return [...userHosts.map(userEntry), ...configHosts.map(configEntry)];
}

/** Entries whose label equals `query`; user labels ignore case, config aliases match exactly. */
export function findHostEntries(query: string, entries: readonly SshHostEntry[]): SshHostEntry[] {
  const wanted = query.trim();
  const lowered = wanted.toLowerCase();
  return entries.filter((entry) =>
    entry.source === "config" ? entry.label === wanted : entry.label.toLowerCase() === lowered,
  );
}

/** Entries whose label or address contain every word of `query`, ignoring case. A blank query keeps all. */
export function filterHostEntries(
  query: string,
  entries: readonly SshHostEntry[],
): readonly SshHostEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = `${entry.label} ${entry.detail}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The host a running session was started for, found by the terminal name `sessionName` gave it. */
export function hostForSession(
  terminalName: string,
  entries: readonly SshHostEntry[],
): SshHostEntry | null {
  return entries.find((entry) => sessionName(entry.label) === terminalName) ?? null;
}

export type NewUserHostResult =
  | { ok: true; host: Omit<SshUserHost, "id"> }
  | { ok: false; error: string };

/** Validates add-form text. `port` is raw text; empty optional fields are dropped. */
export function parseNewUserHost(input: {
  label: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
}): NewUserHostResult {
  const label = input.label.trim();
  const host = input.host.trim();
  const user = input.user.trim();
  const portText = input.port.trim();
  const identityFile = input.identityFile.trim();
  if (!label) return { ok: false, error: "Enter a label" };
  const hostReason = describeUnsafeValue(host);
  if (hostReason) return { ok: false, error: `Host ${hostReason}` };
  if (user) {
    const reason = describeUnsafeValue(user);
    if (reason) return { ok: false, error: `User ${reason}` };
  }
  if (identityFile) {
    const reason = describeUnsafePath(identityFile);
    if (reason) return { ok: false, error: `Identity file ${reason}` };
  }
  let port: number | undefined;
  if (portText) {
    port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
      return { ok: false, error: "Port must be a number from 1 to 65535" };
    }
  }
  return {
    ok: true,
    host: {
      label,
      host,
      ...(user ? { user } : {}),
      ...(port === undefined ? {} : { port }),
      ...(identityFile ? { identityFile } : {}),
    },
  };
}
