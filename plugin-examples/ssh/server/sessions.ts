import { homedir } from "node:os";
import type { z } from "zod";
import type { startSessionRpc } from "../shared/contracts";
import { sessionName } from "../shared/sessions";
import { buildSshInvocation } from "../shared/ssh-args";

type Paseo = import("@getpaseo/plugin/server").PluginHandlerContext["paseo"];
type StartSessionInput = z.output<(typeof startSessionRpc)["input"]>;
type StartSessionResult = z.input<(typeof startSessionRpc)["output"]>;

// COMPAT(pluginWorkspacelessTerminals): a daemon from before workspace-less plugin terminals
// rejects a terminal without a workspace with this message. Remove after 2027-05-01.
const OLD_DAEMON_MESSAGE = "workspaceId is required";

/**
 * Starts `ssh` in a terminal the plugin owns and no workspace has: archiving a workspace leaves it
 * running, and it ends when the plugin stops or the daemon restarts. It starts in the daemon
 * user's home directory. ssh prompts for any password or passphrase inside the terminal.
 */
export async function startSession(
  input: StartSessionInput,
  context: { paseo: Paseo },
): Promise<StartSessionResult> {
  try {
    const { command, args } = buildSshInvocation(input.target);
    const terminal = await context.paseo.terminals.create({
      cwd: homedir(),
      name: sessionName(input.label),
      command,
      args,
      owned: true,
    });
    const created = terminal.current();
    if (!created) throw new Error("The daemon did not report the new session.");
    return { ok: true, session: { id: created.id, cwd: created.cwd, name: created.name } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        message === OLD_DAEMON_MESSAGE
          ? "Update the host to run SSH sessions outside a workspace."
          : message,
    };
  }
}
