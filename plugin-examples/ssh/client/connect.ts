import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import type { SshHostEntry } from "../shared/hosts";
import { buildSshInvocation, hasControlCharacter } from "../shared/ssh-args";

function displayName(label: string): string {
  return [...label].map((char) => (hasControlCharacter(char) ? " " : char)).join("");
}

/** Opens `ssh` as a terminal in the workspace. ssh prompts for any password or passphrase itself. */
export async function openSshTerminal(
  paseo: PluginCommandCapabilities["paseo"],
  workspaceId: string,
  entry: SshHostEntry,
) {
  const { command, args } = buildSshInvocation(entry.target);
  return paseo.terminals.create({
    workspaceId,
    name: `ssh ${displayName(entry.label)}`,
    command,
    args,
  });
}
