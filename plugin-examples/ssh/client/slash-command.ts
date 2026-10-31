import { settingsRpc } from "@getpaseo/plugin";
import type { PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import {
  hostsSettings,
  listConfigHostsRpc,
  startSessionRpc,
  type SshUserHost,
} from "../shared/contracts";
import { findHostEntries, toHostEntries } from "../shared/hosts";
import { openSshSession } from "./connect";

const readHosts = settingsRpc(hostsSettings.id).read;

export async function runSshSlashCommand({
  args,
  rpc,
  openPanel,
}: PluginWorkspaceCommandContext & { args: string }): Promise<void> {
  const query = args.trim();
  if (!query) throw new Error("Usage: /ssh <host>");
  const [config, stored] = await Promise.all([rpc(listConfigHostsRpc, {}), rpc(readHosts, {})]);
  const parsed = stored.status === "ready" ? hostsSettings.schema.safeParse(stored.values) : null;
  const userHosts: SshUserHost[] = parsed?.success ? parsed.data.hosts : [];
  const matches = findHostEntries(query, toHostEntries(config.hosts, userHosts));
  if (matches.length === 0) throw new Error(`No SSH host named "${query}"`);
  if (matches.length > 1) throw new Error(`More than one SSH host is named "${query}"`);
  // The session belongs to no workspace, not even this one: archiving it leaves ssh running.
  await openSshSession((input) => rpc(startSessionRpc, input), matches[0]);
  // The panel lists the running sessions and shows the newest, which is this one.
  openPanel("hosts");
}
