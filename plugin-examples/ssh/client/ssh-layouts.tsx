import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { MIN_TOUCH_TARGET } from "./file-row";
import type { Theme } from "./types";

const HOSTS_PANE_WIDTH = 360;

/** The parts of the SSH screen, already built; a layout only arranges them. */
export interface SshScreenParts {
  theme: Theme;
  header: ReactNode;
  hosts: ReactNode;
  /** Files, or a hint, shown where no session is. */
  files: ReactNode;
  transferList: ReactNode;
  chips: ReactNode;
  /** Why the session list could not be read, e.g. an old host. */
  sessionsError: string | null;
  /** The shown session's terminal, or `null` while the files are shown. */
  session: ReactNode;
  onBackToHosts(): void;
}

function useLayoutStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 12 },
      header: { paddingHorizontal: 24, paddingTop: 24 },
      split: { flex: 1, flexDirection: "row" as const },
      hostsPane: {
        width: HOSTS_PANE_WIDTH,
        flexGrow: 0,
        flexShrink: 0,
        borderRightWidth: 1,
        borderColor: theme.colors.border,
      },
      rightPane: { flex: 1, minWidth: 0 },
      toolbar: { padding: 24, paddingBottom: 12, gap: 8 },
      compactToolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        padding: 16,
        paddingBottom: 12,
        gap: 8,
      },
      back: {
        minHeight: MIN_TOUCH_TARGET,
        minWidth: MIN_TOUCH_TARGET,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, compact],
  );
}

/** Phones: one thing at a time. A session fills the screen, with a way back to the hosts. */
export function CompactSshLayout(parts: SshScreenParts) {
  const styles = useLayoutStyles(parts.theme, true);
  if (parts.session) {
    return (
      <View style={styles.screen}>
        <View style={styles.compactToolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to hosts"
            onPress={parts.onBackToHosts}
            style={styles.back}
          >
            <Icon name="ChevronLeft" size={20} color={parts.theme.colors.foreground} />
          </Pressable>
          {parts.chips}
        </View>
        {parts.session}
      </View>
    );
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {parts.header}
      {parts.chips}
      {parts.sessionsError ? <Text style={styles.error}>{parts.sessionsError}</Text> : null}
      {parts.transferList}
      {parts.files ?? parts.hosts}
    </ScrollView>
  );
}

/** Wide: the hosts beside a pane that switches between the files and a session. */
export function WideSshLayout(parts: SshScreenParts) {
  const styles = useLayoutStyles(parts.theme, false);
  return (
    <View style={styles.screen}>
      {parts.header ? <View style={styles.header}>{parts.header}</View> : null}
      <View style={styles.split}>
        <ScrollView style={styles.hostsPane} contentContainerStyle={styles.content}>
          {parts.hosts}
        </ScrollView>
        <View style={styles.rightPane}>
          <View style={styles.toolbar}>
            {parts.chips}
            {parts.sessionsError ? <Text style={styles.error}>{parts.sessionsError}</Text> : null}
          </View>
          {parts.session ?? (
            <ScrollView contentContainerStyle={styles.content}>
              {parts.transferList}
              {parts.files ?? (
                <Text style={styles.muted}>Choose Files on a host to browse it.</Text>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </View>
  );
}
