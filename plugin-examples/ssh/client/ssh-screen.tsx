import { useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SshHostEntry } from "../shared/hosts";
import { resolveSelection, type SessionSelection } from "../shared/sessions";
import { FilesBrowser, TransferList, useTransfers } from "./files-browser";
import { HostsList } from "./hosts-list";
import { SessionChips } from "./session-chips";
import { CompactSshLayout, WideSshLayout, type SshScreenParts } from "./ssh-layouts";
import { SessionPane } from "./session-pane";
import type { Layout, TargetWorkspace, Theme } from "./types";
import { useSshSessions } from "./use-ssh-sessions";

interface SshScreenProps {
  theme: Theme;
  layout: Layout;
  /** Where sessions run and files go; `null` until the user has chosen one. */
  workspace: TargetWorkspace | null;
  /** Shown above the hosts and files, e.g. the workspace picker. */
  children?: ReactNode;
  /** Changes when the host reopens the screen, e.g. after `/ssh`; the newest session shows again. */
  refreshToken?: number;
}

/**
 * Hosts, a remote file browser with transfers, and the running ssh sessions. Wide layouts put the
 * hosts beside a pane that switches between the files and a session; compact ones show one at a
 * time. The same screen serves the sidebar surface and the workspace panel.
 */
export function SshScreen({
  theme,
  layout,
  workspace,
  children: header,
  refreshToken = 0,
}: SshScreenProps) {
  const toast = useToast();
  const transfers = useTransfers();
  const [browsing, setBrowsing] = useState<SshHostEntry | null>(null);
  const [selection, setSelection] = useState<SessionSelection>({ kind: "auto" });
  const sessions = useSshSessions(workspace?.id ?? null, refreshToken);
  const { refresh } = sessions;
  const resolved = resolveSelection(selection, sessions.sessions);
  const active =
    resolved.kind === "session"
      ? (sessions.sessions.find((session) => session.id === resolved.id) ?? null)
      : null;

  useEffect(() => setSelection({ kind: "auto" }), [refreshToken]);

  const handleConnect = useCallback(
    async (entry: SshHostEntry) => {
      if (!workspace) {
        toast.error("Choose a target workspace first.");
        return;
      }
      try {
        setSelection({ kind: "session", id: await sessions.open(entry) });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [sessions, toast, workspace],
  );
  const handleConnectPress = useCallback(
    (entry: SshHostEntry) => {
      void handleConnect(entry);
    },
    [handleConnect],
  );
  const handleBrowse = useCallback((entry: SshHostEntry) => {
    setBrowsing(entry);
    setSelection({ kind: "files" });
  }, []);
  const closeBrowser = useCallback(() => setBrowsing(null), []);
  const showFiles = useCallback(() => setSelection({ kind: "files" }), []);
  const selectSession = useCallback((id: string) => setSelection({ kind: "session", id }), []);
  const closeSession = useCallback(
    (id: string) => {
      sessions.close(id).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [sessions, toast],
  );
  const handleSessionExit = useCallback(() => void refresh(), [refresh]);

  const wide = !layout.compact;
  const chips =
    sessions.sessions.length > 0 || wide ? (
      <SessionChips
        theme={theme}
        sessions={sessions.sessions}
        activeId={active?.id ?? null}
        onShowFiles={wide ? showFiles : undefined}
        onSelect={selectSession}
        onClose={closeSession}
      />
    ) : null;
  const parts: SshScreenParts = {
    theme,
    header,
    chips,
    hosts: (
      <HostsList
        theme={theme}
        layout={layout}
        selectedKey={browsing?.key ?? null}
        connectDisabled={workspace === null}
        onConnect={handleConnectPress}
        onBrowse={handleBrowse}
      />
    ),
    files: browsing ? (
      <FilesBrowser
        key={browsing.key}
        entry={browsing}
        theme={theme}
        layout={layout}
        workspace={workspace}
        transfers={transfers}
        onClose={wide ? undefined : closeBrowser}
      />
    ) : null,
    transferList: <TransferList theme={theme} transfers={transfers} />,
    sessionsError: sessions.error,
    session: active ? (
      <SessionPane theme={theme} session={active} onExit={handleSessionExit} />
    ) : null,
    onBackToHosts: showFiles,
  };
  return wide ? <WideSshLayout {...parts} /> : <CompactSshLayout {...parts} />;
}
