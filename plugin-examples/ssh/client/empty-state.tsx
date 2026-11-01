import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { SshHostEntry } from "../shared/hosts";
import type { Theme } from "./types";
import { FONT_SIZE, MIN_TOUCH_TARGET, ROW_HEIGHT, SPACE, useHover } from "./ui-kit";

const MAX_SHOWN = 5;
const MAX_WIDTH = 420;

interface QuickHostProps {
  theme: Theme;
  compact: boolean;
  entry: SshHostEntry;
  onConnect(entry: SshHostEntry): void;
}

function QuickHost({ theme, compact, entry, onConnect }: QuickHostProps) {
  const { hovered, handleHoverIn, handleHoverOut } = useHover();
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.md,
        minHeight: compact ? MIN_TOUCH_TARGET + SPACE.sm : ROW_HEIGHT + SPACE.sm,
        paddingHorizontal: SPACE.md,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
      },
      text: { flex: 1, minWidth: 0 },
      label: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
      detail: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
    }),
    [theme, compact, hovered],
  );
  const handlePress = useCallback(() => onConnect(entry), [entry, onConnect]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Quick connect ${entry.label}`}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={styles.row}
    >
      <Icon name="Server" size={16} color={theme.colors.foregroundMuted} />
      <View style={styles.text}>
        <Text style={styles.label} numberOfLines={1}>
          {entry.label}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {entry.detail}
        </Text>
      </View>
      <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

interface EmptyStateProps {
  theme: Theme;
  compact: boolean;
  /** Hosts to offer, the most recently used first. */
  hosts: readonly SshHostEntry[];
  /** True once a host was connected from this screen, so the list is a history. */
  hasRecent: boolean;
  onConnect(entry: SshHostEntry): void;
  /** On a phone: leave for the host list. */
  onChoose?(): void;
}

/** What the terminal area shows while no session is open. */
export function EmptyState({
  theme,
  compact,
  hosts,
  hasRecent,
  onConnect,
  onChoose,
}: EmptyStateProps) {
  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: SPACE.lg,
        backgroundColor: theme.colors.surface0,
      },
      column: { width: "100%" as const, maxWidth: MAX_WIDTH, gap: SPACE.sm },
      head: { alignItems: "center" as const, gap: SPACE.sm, paddingBottom: SPACE.md },
      title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" as const },
      subtitle: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.body,
        textAlign: "center" as const,
      },
      heading: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.4,
        textTransform: "uppercase" as const,
      },
      primary: {
        minHeight: MIN_TOUCH_TARGET,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      primaryText: { color: theme.colors.accentForeground, fontSize: FONT_SIZE.title },
    }),
    [theme],
  );
  const shown = hosts.slice(0, MAX_SHOWN);
  return (
    <View style={styles.root}>
      <View style={styles.column}>
        <View style={styles.head}>
          <Icon name="Terminal" size={32} color={theme.colors.foregroundMuted} />
          <Text style={styles.title}>Pick a host to connect</Text>
          <Text style={styles.subtitle}>
            {compact
              ? "Choose a host, and its terminal opens here."
              : "Double-click a host in the sidebar, or choose one below."}
          </Text>
        </View>
        {shown.length > 0 ? (
          <Text style={styles.heading}>{hasRecent ? "Recent" : "Hosts"}</Text>
        ) : null}
        {shown.map((entry) => (
          <QuickHost
            key={entry.key}
            theme={theme}
            compact={compact}
            entry={entry}
            onConnect={onConnect}
          />
        ))}
        {onChoose ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose a host"
            onPress={onChoose}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>Choose a host</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

interface SftpPlaceholderProps {
  theme: Theme;
  onChoose?(): void;
}

/** What the SFTP view shows before any host is picked. */
export function SftpPlaceholder({ theme, onChoose }: SftpPlaceholderProps) {
  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: SPACE.sm,
        padding: SPACE.lg,
      },
      text: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.body,
        textAlign: "center" as const,
      },
      link: { minHeight: MIN_TOUCH_TARGET, justifyContent: "center" as const },
      linkText: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
    }),
    [theme],
  );
  return (
    <View style={styles.root}>
      <Icon name="FolderTree" size={28} color={theme.colors.foregroundMuted} />
      <Text style={styles.text}>
        Open a session, or press the folder icon on a host, to browse its files.
      </Text>
      {onChoose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go to hosts"
          onPress={onChoose}
          style={styles.link}
        >
          <Text style={styles.linkText}>Go to hosts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
