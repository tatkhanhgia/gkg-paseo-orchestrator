import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { FileEntry } from "../shared/contracts";
import { formatModified, formatSize } from "./format";
import type { Theme } from "./types";

/** Smallest comfortable touch target on a phone, in points. */
export const MIN_TOUCH_TARGET = 44;

interface FileRowProps {
  entry: FileEntry;
  theme: Theme;
  /** Label of the button shown on files, e.g. "Download". */
  actionLabel: string;
  actionIcon: string;
  disabled: boolean;
  onOpenDirectory(entry: FileEntry): void;
  onAction(entry: FileEntry): void;
}

function iconFor(kind: FileEntry["kind"]): string {
  if (kind === "directory") return "Folder";
  if (kind === "symlink") return "Link";
  return "File";
}

export function FileRow({
  entry,
  theme,
  actionLabel,
  actionIcon,
  disabled,
  onOpenDirectory,
  onAction,
}: FileRowProps) {
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        minHeight: MIN_TOUCH_TARGET,
        paddingVertical: 4,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      main: {
        flex: 1,
        minWidth: 0,
        minHeight: MIN_TOUCH_TARGET,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
      },
      text: { flex: 1, minWidth: 0 },
      name: { color: theme.colors.foreground },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      action: {
        width: MIN_TOUCH_TARGET,
        height: MIN_TOUCH_TARGET,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
    }),
    [theme],
  );
  const handleOpen = useCallback(() => onOpenDirectory(entry), [entry, onOpenDirectory]);
  const handleAction = useCallback(() => onAction(entry), [entry, onAction]);
  const meta = [formatSize(entry.size), formatModified(entry.mtime)].filter(Boolean).join(" · ");
  const body = (
    <>
      <Icon name={iconFor(entry.kind)} size={18} color={theme.colors.foregroundMuted} />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {entry.name}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </>
  );
  return (
    <View style={styles.row}>
      {entry.kind === "directory" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open folder ${entry.name}`}
          onPress={handleOpen}
          style={styles.main}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.main}>{body}</View>
      )}
      {entry.kind === "file" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel} ${entry.name}`}
          disabled={disabled}
          onPress={handleAction}
          style={styles.action}
        >
          <Icon name={actionIcon} size={16} color={theme.colors.accentForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}
