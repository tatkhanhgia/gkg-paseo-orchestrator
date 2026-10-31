import { settingsRpc } from "@getpaseo/plugin";
import type { PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { hostsSettings, listConfigHostsRpc, type SshUserHost } from "../shared/contracts";
import { findHostEntries, toHostEntries } from "../shared/hosts";
import { openSshSession } from "./connect";

const readHosts = settingsRpc(hostsSettings.id).read;

export async function runSshSlashCommand({
  args,
  workspace,
  paseo,
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
  await openSshSession(paseo, workspace.id, matches[0]);
  // The panel lists the workspace's running sessions and shows the newest, which is this one.
  openPanel("hosts");
}
