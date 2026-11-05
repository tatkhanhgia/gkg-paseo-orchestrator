import { useMemo } from "react";
import { Text, View } from "react-native";
import type { SshHostEntry } from "../shared/hosts";
import type { Theme } from "./types";
import { FONT_SIZE, SPACE, StatusDot } from "./ui-kit";

const BAR_HEIGHT = 28;

interface StatusBarProps {
  theme: Theme;
  /** The host of the shown session, when it is known. */
  host: SshHostEntry | null;
  /** The shown session's terminal name, the fallback when its host is not in the list. */
  sessionName: string | null;
  sessionCount: number;
  transferCount: number;
}

/** One quiet line under the screen: the host, its connection state, and a transfer summary. */
export function StatusBar({
  theme,
  host,
  sessionName,
  sessionCount,
  transferCount,
}: StatusBarProps) {
  const connected = sessionName !== null;
  const styles = useMemo(
    () => ({
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.md,
        height: BAR_HEIGHT,
        paddingHorizontal: SPACE.md,
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      state: { flexDirection: "row" as const, alignItems: "center" as const, gap: SPACE.sm - 2 },
      text: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
      strong: { color: theme.colors.foreground, fontSize: FONT_SIZE.small },
      detail: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
      },
    }),
    [theme],
  );
  const sessions = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`;
  const transfers =
    transferCount === 0
      ? "No transfers"
      : `${transferCount} ${transferCount === 1 ? "transfer" : "transfers"}`;
  return (
    <View accessibilityRole="summary" style={styles.bar}>
      <View style={styles.state}>
        <StatusDot color={connected ? theme.colors.statusSuccess : theme.colors.foregroundMuted} />
        <Text style={styles.strong}>{connected ? "Connected" : "Not connected"}</Text>
      </View>
      <Text style={styles.detail} numberOfLines={1}>
        {host ? `${host.label} · ${host.detail}` : (sessionName ?? "Pick a host to connect")}
      </Text>
      <Text style={styles.text}>{sessions}</Text>
      <Text style={styles.text}>{transfers}</Text>
    </View>
  );
}
