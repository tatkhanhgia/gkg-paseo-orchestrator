import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { MIN_TOUCH_TARGET } from "./file-row";
import type { Theme } from "./types";

const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

interface SessionChipsProps {
  theme: Theme;
  sessions: readonly { id: string; name: string }[];
  /** The shown session; `null` while the files are shown. */
  activeId: string | null;
  /** Wide layouts add a chip for the files next to the sessions. */
  onShowFiles?(): void;
  onSelect(id: string): void;
  onClose(id: string): void;
}

interface ChipProps {
  theme: Theme;
  id: string;
  label: string;
  active: boolean;
  onSelect(id: string): void;
  onClose?(id: string): void;
}

function Chip({ theme, id, label, active, onSelect, onClose }: ChipProps) {
  const styles = useMemo(
    () => ({
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
      },
      label: {
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
      },
      labelText: {
        color: theme.colors.foreground,
        fontWeight: active ? ("600" as const) : undefined,
      },
      close: {
        minWidth: MIN_TOUCH_TARGET,
        minHeight: MIN_TOUCH_TARGET,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
    }),
    [theme, active],
  );
  const handleSelect = useCallback(() => onSelect(id), [id, onSelect]);
  const handleClose = useCallback(() => onClose?.(id), [id, onClose]);
  return (
    <View style={styles.chip}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={active ? SELECTED : NOT_SELECTED}
        onPress={handleSelect}
        style={styles.label}
      >
        <Text style={styles.labelText} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {onClose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${label}`}
          onPress={handleClose}
          style={styles.close}
        >
          <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const FILES_CHIP_ID = "files";

/** Switches between the files and the running ssh sessions, and closes a session. */
export function SessionChips({
  theme,
  sessions,
  activeId,
  onShowFiles,
  onSelect,
  onClose,
}: SessionChipsProps) {
  const row = useMemo(
    () => ({ flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 }),
    [],
  );
  const handleShowFiles = useCallback(() => onShowFiles?.(), [onShowFiles]);
  return (
    <View style={row}>
      {onShowFiles ? (
        <Chip
          theme={theme}
          id={FILES_CHIP_ID}
          label="Files"
          active={activeId === null}
          onSelect={handleShowFiles}
        />
      ) : null}
      {sessions.map((session) => (
        <Chip
          key={session.id}
          theme={theme}
          id={session.id}
          label={session.name}
          active={session.id === activeId}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </View>
  );
}
