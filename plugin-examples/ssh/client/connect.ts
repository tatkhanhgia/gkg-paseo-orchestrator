import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import type { SshHostEntry } from "../shared/hosts";
import { sessionName } from "../shared/sessions";
import { buildSshInvocation } from "../shared/ssh-args";

/**
 * Starts `ssh` in an owned terminal: bound to the workspace but hidden from its terminal tabs, so
 * the plugin shows it itself. ssh prompts for any password or passphrase in that terminal.
 */
export async function openSshSession(
  paseo: PluginCommandCapabilities["paseo"],
  workspaceId: string,
  entry: SshHostEntry,
) {
  const { command, args } = buildSshInvocation(entry.target);
  return paseo.terminals.create({
    workspaceId,
    name: sessionName(entry.label),
    command,
    args,
    owned: true,
  });
}
