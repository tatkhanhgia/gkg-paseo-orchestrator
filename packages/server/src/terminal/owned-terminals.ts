import type pino from "pino";
import type { TerminalManager } from "./terminal-manager.js";

/**
 * Ends every terminal created with exactly `owner`, workspace-bound or not, and waits for each to
 * exit. A plugin's terminals die with the plugin: this runs when it stops, reloads, crashes, or is
 * removed, and before it starts again so leftovers from an unclean stop never pile up.
 */
export async function killOwnedTerminals(
  dependencies: { terminalManager: TerminalManager; logger: pino.Logger },
  owner: string,
): Promise<void> {
  const { terminalManager, logger } = dependencies;
  const terminalIds = new Set<string>();
  for (const cwd of terminalManager.listDirectories()) {
    try {
      for (const terminal of await terminalManager.getTerminals(cwd, { owner })) {
        terminalIds.add(terminal.id);
      }
    } catch (error) {
      logger.warn({ err: error, cwd, owner }, "Failed to enumerate owned terminals");
    }
  }
  await Promise.allSettled(
    [...terminalIds].map(async (terminalId) => {
      try {
        await terminalManager.killTerminalAndWait(terminalId, {
          gracefulTimeoutMs: 2000,
          forceTimeoutMs: 1500,
        });
      } catch (error) {
        logger.warn({ err: error, terminalId, owner }, "Failed to end an owned terminal");
      }
    }),
  );
}
