import { hasControlCharacter } from "./ssh-args";

/** What the user asked the session area to show. `auto` follows the running sessions. */
export type SessionSelection =
  | { kind: "auto" }
  | { kind: "files" }
  | { kind: "session"; id: string };

export type ResolvedSelection = { kind: "files" } | { kind: "session"; id: string };

/**
 * What to show now. `auto` shows the newest session, or the files when none is running. A chosen
 * session that has since ended (ssh exited, or the user closed it) falls back the same way.
 */
export function resolveSelection(
  selection: SessionSelection,
  sessions: readonly { id: string }[],
): ResolvedSelection {
  if (selection.kind === "files") return selection;
  if (selection.kind === "session" && sessions.some((session) => session.id === selection.id)) {
    return selection;
  }
  const newest = sessions[sessions.length - 1];
  return newest ? { kind: "session", id: newest.id } : { kind: "files" };
}

/** The terminal name for a host. Labels come from user config, so control characters become spaces. */
export function sessionName(label: string): string {
  return `ssh ${[...label].map((char) => (hasControlCharacter(char) ? " " : char)).join("")}`;
}
