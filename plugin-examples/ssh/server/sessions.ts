import { homedir } from "node:os";
import type { z } from "zod";
import type { startSessionRpc } from "../shared/contracts";
import { sessionName } from "../shared/sessions";
import { buildSshInvocation } from "../shared/ssh-args";
import { prepareVpn } from "./vpn";

type Paseo = import("@getpaseo/plugin/server").PluginHandlerContext["paseo"];
type StartSessionInput = z.output<(typeof startSessionRpc)["input"]>;
type StartSessionResult = z.input<(typeof startSessionRpc)["output"]>;

/**
 * Starts `ssh` in a terminal the plugin owns and no workspace has: archiving a workspace leaves it
 * running, and it ends when the plugin stops or the daemon restarts. It starts in the daemon
 * user's home directory. ssh prompts for any password or passphrase inside the terminal.
 *
 * A host with a VPN profile first opens the VPN (a preflight, so a failure returns here and no
 * terminal exists), then runs `bash <script> exec ... -- ssh ...` in the terminal: ssh itself holds
 * the VPN lease, so the lease ends exactly when the session does.
 */
export async function startSession(
  input: StartSessionInput,
  context: { paseo: Paseo },
): Promise<StartSessionResult> {
  // COMPAT(pluginWorkspacelessTerminals): a daemon from before workspace-less plugin terminals
  // has no terminal capabilities and would refuse the create below. Remove after 2027-05-01.
  if (context.paseo.terminals.capabilities?.workspacelessOwned !== true) {
    return { ok: false, message: "Update the host to run SSH sessions outside a workspace." };
  }
  try {
    const ssh = buildSshInvocation(input.target);
    const vpn = await prepareVpn(input.target);
    const { command, args } = vpn ? vpn.wrap(ssh) : ssh;
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
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
