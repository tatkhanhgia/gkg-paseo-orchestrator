import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { Theme } from "./types";
import { FONT_SIZE, SegmentedControl, SPACE } from "./ui-kit";

const SIDEBAR_WIDTH = 280;

/** Which view is on screen. Wide layouts have Sessions and SFTP in the sidebar; phones add Terminal. */
export type SshView = "sessions" | "terminal" | "sftp";

const WIDE_SEGMENTS = [
  { value: "sessions", label: "Sessions", icon: "Server" },
  { value: "sftp", label: "SFTP", icon: "FolderTree" },
] as const;

const COMPACT_SEGMENTS = [
  { value: "sessions", label: "Sessions", icon: "Server" },
  { value: "terminal", label: "Terminal", icon: "Terminal" },
  { value: "sftp", label: "SFTP", icon: "FolderTree" },
] as const;

/** The parts of the SSH screen, already built; a layout only arranges them. */
export interface SshScreenParts {
  theme: Theme;
  view: SshView;
  onViewChange(view: SshView): void;
  /** The host list: the Sessions view. */
  hosts: ReactNode;
  /** The file browser, or a hint: the SFTP view. */
  files: ReactNode;
  /** The open sessions as tabs. */
  tabs: ReactNode;
  /** The shown session's terminal, or the empty state. */
  terminal: ReactNode;
  /** Running transfers, docked under whichever view is open so their polling never stops. */
  transferDock: ReactNode;
  statusBar: ReactNode;
  /** Why the session list could not be read, e.g. an old host. */
  sessionsError: string | null;
}

function useLayoutStyles(theme: Theme) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      split: { flex: 1, minHeight: 0, flexDirection: "row" as const },
      sidebar: {
        width: SIDEBAR_WIDTH,
        flexGrow: 0,
        flexShrink: 0,
        borderRightWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      switcher: { padding: SPACE.sm, paddingBottom: SPACE.xs },
      fill: { flex: 1, minHeight: 0 },
      main: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.surface0 },
      error: {
        color: theme.colors.statusDanger,
        fontSize: FONT_SIZE.small,
        padding: SPACE.sm,
      },
    }),
    [theme],
  );
}

/** Phones: a switch across the top, and one view at a time at full width. */
export function CompactSshLayout(parts: SshScreenParts) {
  const styles = useLayoutStyles(parts.theme);
  let body: ReactNode = parts.hosts;
  if (parts.view === "sftp") body = parts.files;
  if (parts.view === "terminal") {
    body = (
      <>
        {parts.tabs}
        {parts.terminal}
      </>
    );
  }
  return (
    <View style={styles.screen}>
      <View style={styles.switcher}>
        <SegmentedControl
          theme={parts.theme}
          segments={COMPACT_SEGMENTS}
          value={parts.view}
          compact
          onChange={parts.onViewChange}
        />
      </View>
      {parts.sessionsError ? <Text style={styles.error}>{parts.sessionsError}</Text> : null}
      <View style={styles.fill}>{body}</View>
      {parts.transferDock}
      {parts.statusBar}
    </View>
  );
}

/** Wide: a sidebar of hosts or files beside the session tabs and terminal, a status bar below. */
export function WideSshLayout(parts: SshScreenParts) {
  const styles = useLayoutStyles(parts.theme);
  const view = parts.view === "sftp" ? "sftp" : "sessions";
  return (
    <View style={styles.screen}>
      <View style={styles.split}>
        <View style={styles.sidebar}>
          <View style={styles.switcher}>
            <SegmentedControl
              theme={parts.theme}
              segments={WIDE_SEGMENTS}
              value={view}
              compact={false}
              onChange={parts.onViewChange}
            />
          </View>
          <View style={styles.fill}>{view === "sftp" ? parts.files : parts.hosts}</View>
          {parts.transferDock}
        </View>
        <View style={styles.main}>
          {parts.sessionsError ? <Text style={styles.error}>{parts.sessionsError}</Text> : null}
          {parts.tabs}
          {parts.terminal}
        </View>
      </View>
      {parts.statusBar}
    </View>
  );
}
