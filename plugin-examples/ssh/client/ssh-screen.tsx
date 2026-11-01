import { useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hostForSession, type SshHostEntry } from "../shared/hosts";
import { resolveSelection, type SessionSelection } from "../shared/sessions";
import { EmptyState, SftpPlaceholder } from "./empty-state";
import { FilesBrowser } from "./files-browser";
import { HostsList } from "./hosts-list";
import { SessionPane } from "./session-pane";
import { SessionTabs } from "./session-tabs";
import { CompactSshLayout, WideSshLayout, type SshScreenParts, type SshView } from "./ssh-layouts";
import { StatusBar } from "./status-bar";
import { TransferList, useTransfers } from "./transfers";
import type { Layout, Theme } from "./types";
import { useHostEntries } from "./use-host-entries";
import { useSshSessions } from "./use-ssh-sessions";

const MAX_RECENT = 5;

interface SshScreenProps {
  theme: Theme;
  layout: Layout;
  /** Changes when the host reopens the screen, e.g. after `/ssh`; the newest session shows again. */
  refreshToken?: number;
}

/**
 * A MobaXterm-style SSH screen. Wide layouts put a sidebar (Sessions: the hosts; SFTP: the files
 * of the active host) beside the session tabs and terminal, with a status bar below. Phones show
 * one of Sessions, Terminal, or SFTP at a time. The same screen serves the sidebar surface and the
 * workspace panel, and neither uses a workspace: sessions are terminals the plugin owns, and files
 * move between the remote host and this device.
 */
export function SshScreen({ theme, layout, refreshToken = 0 }: SshScreenProps) {
  const toast = useToast();
  const transfers = useTransfers();
  const hosts = useHostEntries();
  const sessions = useSshSessions(refreshToken);
  const [browsing, setBrowsing] = useState<SshHostEntry | null>(null);
  const [selection, setSelection] = useState<SessionSelection>({ kind: "auto" });
  const [chosenView, setChosenView] = useState<SshView | null>(null);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [recentKeys, setRecentKeys] = useState<readonly string[]>([]);
  const { refresh } = sessions;
  const wide = !layout.compact;
  const resolved = resolveSelection(selection, sessions.sessions);
  const active =
    resolved.kind === "session"
      ? (sessions.sessions.find((session) => session.id === resolved.id) ?? null)
      : null;
  const activeHost = useMemo(
    () => (active ? hostForSession(active.name, hosts.entries) : null),
    [active, hosts.entries],
  );
  const connectedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const session of sessions.sessions) {
      const host = hostForSession(session.name, hosts.entries);
      if (host) keys.add(host.key);
    }
    return keys;
  }, [sessions.sessions, hosts.entries]);
  // A phone that has a session shows its terminal first; otherwise the hosts.
  const view: SshView = chosenView ?? (!wide && active ? "terminal" : "sessions");
  const sftpHost = browsing ?? activeHost;

  useEffect(() => {
    setSelection({ kind: "auto" });
    setChosenView(null);
  }, [refreshToken]);

  const handleConnect = useCallback(
    async (entry: SshHostEntry) => {
      setConnectingKey(entry.key);
      try {
        const id = await sessions.open(entry);
        setSelection({ kind: "session", id });
        setBrowsing(null);
        setRecentKeys((current) =>
          [entry.key, ...current.filter((key) => key !== entry.key)].slice(0, MAX_RECENT),
        );
        if (!wide) setChosenView("terminal");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setConnectingKey(null);
      }
    },
    [sessions, toast, wide],
  );
  const handleConnectPress = useCallback(
    (entry: SshHostEntry) => {
      void handleConnect(entry);
    },
    [handleConnect],
  );
  const handleBrowse = useCallback((entry: SshHostEntry) => {
    setBrowsing(entry);
    setChosenView("sftp");
  }, []);
  const selectSession = useCallback(
    (id: string) => {
      setSelection({ kind: "session", id });
      setBrowsing(null);
      if (!wide) setChosenView("terminal");
    },
    [wide],
  );
  const closeSession = useCallback(
    (id: string) => {
      sessions.close(id).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [sessions, toast],
  );
  const handleSessionExit = useCallback(() => void refresh(), [refresh]);
  const showHosts = useCallback(() => setChosenView("sessions"), []);
  const handleViewChange = useCallback((next: SshView) => setChosenView(next), []);

  // Hosts to offer on the empty state: the ones connected from this screen first.
  const offered = useMemo(() => {
    const recent = recentKeys.flatMap((key) => hosts.entries.filter((entry) => entry.key === key));
    return [...recent, ...hosts.entries.filter((entry) => !recentKeys.includes(entry.key))];
  }, [recentKeys, hosts.entries]);

  const parts: SshScreenParts = {
    theme,
    view,
    onViewChange: handleViewChange,
    hosts: (
      <HostsList
        theme={theme}
        layout={layout}
        hosts={hosts}
        connectedKeys={connectedKeys}
        connectingKey={connectingKey}
        onConnect={handleConnectPress}
        onBrowse={handleBrowse}
      />
    ),
    files: sftpHost ? (
      <FilesBrowser
        key={sftpHost.key}
        entry={sftpHost}
        theme={theme}
        layout={layout}
        transfers={transfers}
      />
    ) : (
      <SftpPlaceholder theme={theme} onChoose={wide ? undefined : showHosts} />
    ),
    tabs:
      sessions.sessions.length > 0 ? (
        <SessionTabs
          theme={theme}
          compact={!wide}
          sessions={sessions.sessions}
          activeId={active?.id ?? null}
          onSelect={selectSession}
          onClose={closeSession}
          onNew={showHosts}
        />
      ) : null,
    terminal: active ? (
      <SessionPane theme={theme} compact={!wide} session={active} onExit={handleSessionExit} />
    ) : (
      <EmptyState
        theme={theme}
        compact={!wide}
        hosts={offered}
        hasRecent={recentKeys.length > 0}
        onConnect={handleConnectPress}
        onChoose={wide ? undefined : showHosts}
      />
    ),
    transferDock: <TransferList theme={theme} compact={!wide} transfers={transfers} />,
    statusBar: (
      <StatusBar
        theme={theme}
        host={activeHost}
        sessionName={active?.name ?? null}
        sessionCount={sessions.sessions.length}
        transferCount={transfers.refs.length}
      />
    ),
    sessionsError: sessions.error,
  };
  return wide ? <WideSshLayout {...parts} /> : <CompactSshLayout {...parts} />;
}
