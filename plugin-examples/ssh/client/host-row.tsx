import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import type { SshHostEntry } from "../shared/hosts";
import type { Theme } from "./types";
import {
  FONT_SIZE,
  IconButton,
  MIN_TOUCH_TARGET,
  ROW_HEIGHT,
  SPACE,
  StatusDot,
  showRowActions,
  useHover,
} from "./ui-kit";

/** Two presses on one row within this many milliseconds count as a double-click. */
const DOUBLE_PRESS_MS = 350;
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

export type HostStatus = "idle" | "connecting" | "connected";

interface HostRowProps {
  entry: SshHostEntry;
  theme: Theme;
  compact: boolean;
  busy: boolean;
  selected: boolean;
  status: HostStatus;
  onSelect(entry: SshHostEntry): void;
  onConnect(entry: SshHostEntry): void;
  onBrowse(entry: SshHostEntry): void;
  onEdit(entry: SshHostEntry): void;
  onRemove(entry: SshHostEntry): void;
}

function statusColor(theme: Theme, status: HostStatus): string | null {
  if (status === "connected") return theme.colors.statusSuccess;
  return status === "connecting" ? theme.colors.statusWarning : null;
}

/**
 * One host. A wide row is a single line: server icon, label, and the muted `user@host:port`. Its
 * action buttons float over the right end while the row is hovered or selected. A compact row has
 * two lines and its actions are always there, each a 44-point target; a tap connects.
 */
export function HostRow({
  entry,
  theme,
  compact,
  busy,
  selected,
  status,
  onSelect,
  onConnect,
  onBrowse,
  onEdit,
  onRemove,
}: HostRowProps) {
  const { hovered, handleHoverIn, handleHoverOut } = useHover();
  const lastPress = useRef(0);
  const dotColor = statusColor(theme, status);
  const actionsVisible = showRowActions(hovered, selected, compact);
  const highlighted = hovered || selected;
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minHeight: compact ? MIN_TOUCH_TARGET + SPACE.md : ROW_HEIGHT,
        borderRadius: 6,
        backgroundColor: highlighted ? theme.colors.surface2 : "transparent",
      },
      main: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
        minHeight: compact ? MIN_TOUCH_TARGET + SPACE.md : ROW_HEIGHT,
        paddingHorizontal: SPACE.sm,
      },
      text: { flex: 1, minWidth: 0 },
      oneLine: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
      },
      label: {
        flexShrink: 1,
        color: theme.colors.foreground,
        fontSize: FONT_SIZE.body,
        fontWeight: selected ? ("600" as const) : ("400" as const),
      },
      detail: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
      },
      detailBelow: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
      floating: {
        position: "absolute" as const,
        top: 0,
        bottom: 0,
        right: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: SPACE.xs,
        borderRadius: 6,
        backgroundColor: actionsVisible ? theme.colors.surface2 : "transparent",
      },
      inline: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingRight: SPACE.xs,
      },
    }),
    [theme, compact, highlighted, selected, actionsVisible],
  );
  const handlePress = useCallback(() => {
    const now = Date.now();
    const doublePress = now - lastPress.current < DOUBLE_PRESS_MS;
    lastPress.current = now;
    if (compact || doublePress) onConnect(entry);
    else onSelect(entry);
  }, [compact, entry, onConnect, onSelect]);
  const handleConnect = useCallback(() => onConnect(entry), [entry, onConnect]);
  const handleBrowse = useCallback(() => onBrowse(entry), [entry, onBrowse]);
  const handleEdit = useCallback(() => onEdit(entry), [entry, onEdit]);
  const handleRemove = useCallback(() => onRemove(entry), [entry, onRemove]);
  const isUser = entry.source === "user";

  const actions = (
    <>
      <IconButton
        theme={theme}
        compact={compact}
        icon="Plug"
        label={`Connect to ${entry.label}`}
        hidden={!actionsVisible}
        onPress={handleConnect}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      />
      <IconButton
        theme={theme}
        compact={compact}
        icon="FolderOpen"
        label={`Browse files on ${entry.label}`}
        hidden={!actionsVisible}
        onPress={handleBrowse}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      />
      {isUser ? (
        <IconButton
          theme={theme}
          compact={compact}
          icon="Pencil"
          label={`Edit ${entry.label}`}
          disabled={busy}
          hidden={!actionsVisible}
          onPress={handleEdit}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
        />
      ) : null}
      {isUser && !compact ? (
        <IconButton
          theme={theme}
          compact={compact}
          icon="Trash2"
          tone="danger"
          label={`Remove ${entry.label}`}
          disabled={busy}
          hidden={!actionsVisible}
          onPress={handleRemove}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
        />
      ) : null}
    </>
  );
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={entry.label}
        accessibilityHint={entry.detail}
        accessibilityState={selected ? SELECTED : NOT_SELECTED}
        onPress={handlePress}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={styles.main}
      >
        <Icon name="Server" size={16} color={dotColor ?? theme.colors.foregroundMuted} />
        {compact ? (
          <View style={styles.text}>
            <Text style={styles.label} numberOfLines={1}>
              {entry.label}
            </Text>
            <Text style={styles.detailBelow} numberOfLines={1}>
              {entry.detail}
            </Text>
          </View>
        ) : (
          <View style={styles.oneLine}>
            <Text style={styles.label} numberOfLines={1}>
              {entry.label}
            </Text>
            {dotColor ? <StatusDot color={dotColor} /> : null}
            <Text style={styles.detail} numberOfLines={1}>
              {entry.detail}
            </Text>
          </View>
        )}
      </Pressable>
      <View style={compact ? styles.inline : styles.floating}>{actions}</View>
    </View>
  );
}
