import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

const TerminalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  name: z.string(),
  owner: z.string().optional(),
});

export type PaseoTerminal = z.infer<typeof TerminalSchema>;

export interface PaseoTerminalCreateOptions {
  /**
   * The workspace the terminal belongs to. Required, except for an owned terminal created from a
   * plugin's server code, which may omit it and pass `cwd` instead: that terminal belongs to the
   * plugin alone, no workspace lists or archives it, and it ends when the plugin stops.
   */
  workspaceId?: string;
  /** Process working directory; defaults to the workspace directory. Required without a workspace. */
  cwd?: string;
  name?: string;
  command?: string;
  args?: string[];
  size?: { rows: number; cols: number };
  /**
   * Create the terminal under this API's `terminalOwner`: it is hidden from workspace terminal
   * lists, tabs, status, and notifications. With a workspace it stays bound to that workspace.
   */
  owned?: boolean;
  requestId?: string;
}

export interface PaseoTerminalActionsOptions {
  /**
   * Allow `create({ owned: true })` without a workspace. Only a plugin's own subprocess API sets
   * this: the daemon accepts such a terminal only from the plugin session that owns it.
   */
  workspacelessOwned?: boolean;
}

export interface PaseoTerminalListOptions {
  /** Ownership filter. When supplied, cwd does not restrict the results. */
  workspaceId?: string;
  /** Workspace root directory filter for unscoped listings. */
  cwd?: string;
  /** List only the terminals owned by this API's `terminalOwner` instead of workspace terminals. */
  owned?: boolean;
  requestId?: string;
}

export interface PaseoTerminalListResult {
  entries: PaseoTerminal[];
  requestId: string;
}

export interface PaseoTerminalCaptureOptions {
  start?: number;
  end?: number;
  stripAnsi?: boolean;
  requestId?: string;
}

export type PaseoTerminalCaptureResult = Awaited<ReturnType<DaemonClient["captureTerminal"]>>;

export interface PaseoTerminalHandle {
  readonly id: string;
  current(): PaseoTerminal | null;
  refresh(options?: { requestId?: string }): Promise<PaseoTerminal | null>;
  /** Sends literal input and returns its UTF-16 length. Does not await command execution. */
  write(data: string): number;
  /** Expands CLI key tokens; other strings are literal. Returns the input's UTF-16 length. */
  sendKeys(keys: readonly string[]): number;
  capture(options?: PaseoTerminalCaptureOptions): Promise<PaseoTerminalCaptureResult>;
  kill(requestId?: string): Promise<void>;
}

export interface PaseoTerminalActions {
  create(options: PaseoTerminalCreateOptions): Promise<PaseoTerminalHandle>;
  list(options?: PaseoTerminalListOptions): Promise<PaseoTerminalListResult>;
  ref(terminal: string | PaseoTerminal): PaseoTerminalHandle;
}

export interface PaseoWorkspaceTerminalActions {
  create(options?: Omit<PaseoTerminalCreateOptions, "workspaceId">): Promise<PaseoTerminalHandle>;
  list(options?: { owned?: boolean; requestId?: string }): Promise<PaseoTerminalListResult>;
}

type TerminalClient = Pick<
  DaemonClient,
  | "ensureConnected"
  | "getLastServerInfoMessage"
  | "createTerminal"
  | "listTerminals"
  | "sendTerminalInput"
  | "captureTerminal"
  | "killTerminal"
>;

/** @package */
export function createTerminalActions(
  daemonClient: TerminalClient,
  resolveWorkspaceDirectory: (workspaceId: string) => Promise<string>,
  terminalOwner?: string,
  actionOptions: PaseoTerminalActionsOptions = {},
): PaseoTerminalActions {
  function client(): TerminalClient {
    daemonClient.ensureConnected();
    // COMPAT(workspaceTerminals): added in v0.7.3, remove gate after 2027-09-05.
    if (daemonClient.getLastServerInfoMessage()?.features?.workspaceTerminals !== true) {
      throw new Error("Update the host to use workspace terminals through the SDK.");
    }
    return daemonClient;
  }

  const resolveOwner = (owned: boolean | undefined): string | undefined => {
    if (!owned) return undefined;
    if (terminalOwner === undefined) {
      throw new Error("Owned terminals require an API created with a terminalOwner.");
    }
    // COMPAT(ownedTerminals): added in v0.13.2-paseo.3, remove gate after 2027-04-30.
    if (daemonClient.getLastServerInfoMessage()?.features?.["owned-terminals"] !== true) {
      throw new Error("Update the host to use owned terminals.");
    }
    return terminalOwner;
  };

  const list = async (options: PaseoTerminalListOptions = {}): Promise<PaseoTerminalListResult> => {
    const driver = client();
    const owner = resolveOwner(options.owned);
    const result = await driver.listTerminals(options.cwd, options.requestId, {
      workspaceId: options.workspaceId,
      ...(owner === undefined ? {} : { owner }),
    });
    return {
      entries: result.terminals.map((terminal) => TerminalSchema.parse(terminal)),
      requestId: result.requestId,
    };
  };

  const ref = (terminal: string | PaseoTerminal): PaseoTerminalHandle => {
    const id = typeof terminal === "string" ? terminal : terminal.id;
    let current = typeof terminal === "string" ? null : terminal;
    const write = (data: string): number => {
      client().sendTerminalInput(id, { type: "input", data });
      return data.length;
    };
    return {
      id,
      current: () => current,
      refresh: async (options) => {
        const result = await list({ ...options, owned: current?.owner !== undefined });
        current = result.entries.find((entry) => entry.id === id) ?? null;
        return current;
      },
      write,
      sendKeys: (keys) => write(keys.map(resolveKeyToken).join("")),
      capture: (options = {}) => {
        const { requestId, ...captureOptions } = options;
        return client().captureTerminal(id, captureOptions, requestId);
      },
      kill: async (requestId) => {
        const result = await client().killTerminal(id, requestId);
        if (!result.success) throw new Error(`Failed to kill terminal ${id}`);
        current = null;
      },
    };
  };

  return {
    create: async ({ workspaceId, cwd, name, requestId, owned, ...createOptions }) => {
      const driver = client();
      if (!workspaceId && (!owned || !actionOptions.workspacelessOwned)) {
        throw new Error("workspaceId is required");
      }
      const owner = resolveOwner(owned);
      let directory = cwd;
      if (directory === undefined) {
        if (!workspaceId) throw new Error("cwd is required for a terminal without a workspace");
        directory = await resolveWorkspaceDirectory(workspaceId);
      }
      const result = await driver.createTerminal(directory, name, requestId, {
        ...createOptions,
        ...(workspaceId ? { workspaceId } : {}),
        ...(owner === undefined ? {} : { owner }),
      });
      if (result.error || !result.terminal) {
        throw new Error(result.error ?? "The daemon did not create a terminal");
      }
      return ref(TerminalSchema.parse(result.terminal));
    },
    list,
    ref,
  };
}

function resolveKeyToken(key: string): string {
  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}
