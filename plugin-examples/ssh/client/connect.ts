import type { z } from "zod";
import type { startSessionRpc } from "../shared/contracts";
import type { SshHostEntry } from "../shared/hosts";
import { canShowSessions } from "./session-pane";

type StartSession = (
  input: z.input<(typeof startSessionRpc)["input"]>,
) => Promise<z.output<(typeof startSessionRpc)["output"]>>;

/**
 * Starts `ssh` to `entry` in a terminal the plugin owns, outside every workspace, and returns the
 * session. The daemon creates it; the plugin shows it. ssh prompts for any password or passphrase
 * in that terminal.
 */
export async function openSshSession(startSession: StartSession, entry: SshHostEntry) {
  // An app that cannot render the terminal would leave ssh running where nobody can see it.
  if (!canShowSessions) throw new Error("Update the Paseo app to use SSH sessions here.");
  const result = await startSession({ target: entry.target, label: entry.label });
  if (!result.ok) throw new Error(result.message);
  return result.session;
}
