import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { FileEntry } from "../shared/contracts";
import { formatModified, formatSize } from "./format";
import type { Theme } from "./types";
import { FONT_SIZE, IconButton, MIN_TOUCH_TARGET, SPACE, showRowActions, useHover } from "./ui-kit";

const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };
const WIDE_ROW_HEIGHT = 40;
const SIZE_COLUMN_WIDTH = 56;

interface FileRowProps {
  entry: FileEntry;
  theme: Theme;
  compact: boolean;
  /** Only files can be selected; a folder opens when pressed. */
  selected: boolean;
  disabled: boolean;
  onSelect(entry: FileEntry): void;
  onOpenDirectory(entry: FileEntry): void;
  onDownload(entry: FileEntry): void;
}

function iconFor(kind: FileEntry["kind"]): string {
  if (kind === "directory") return "Folder";
  if (kind === "symlink") return "Link";
  return "File";
}

/** One entry of the remote folder: icon, name over modified time, size, and a download button. */
export function FileRow({
  entry,
  theme,
  compact,
  selected,
  disabled,
  onSelect,
  onOpenDirectory,
  onDownload,
}: FileRowProps) {
  const { hovered, handleHoverIn, handleHoverOut } = useHover();
  const isFile = entry.kind === "file";
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minHeight: compact ? MIN_TOUCH_TARGET + SPACE.sm : WIDE_ROW_HEIGHT,
        borderRadius: 6,
        backgroundColor: selected || hovered ? theme.colors.surface2 : "transparent",
      },
      main: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
        minHeight: compact ? MIN_TOUCH_TARGET + SPACE.sm : WIDE_ROW_HEIGHT,
        paddingLeft: SPACE.sm,
      },
      text: { flex: 1, minWidth: 0 },
      name: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
      modified: { color: theme.colors.foregroundMuted, fontSize: 11 },
      size: {
        width: SIZE_COLUMN_WIDTH,
        textAlign: "right" as const,
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
      },
      trailing: {
        width: compact ? MIN_TOUCH_TARGET : 28,
        marginRight: SPACE.xs,
        alignItems: "center" as const,
      },
    }),
    [theme, compact, selected, hovered],
  );
  const handlePress = useCallback(() => {
    if (entry.kind === "directory") onOpenDirectory(entry);
    else onSelect(entry);
  }, [entry, onOpenDirectory, onSelect]);
  const handleDownload = useCallback(() => onDownload(entry), [entry, onDownload]);
  const modified = formatModified(entry.mtime);
  const size = entry.kind === "directory" ? "" : formatSize(entry.size);
  const label = entry.kind === "directory" ? `Open folder ${entry.name}` : `Select ${entry.name}`;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={selected ? SELECTED : NOT_SELECTED}
        onPress={handlePress}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={styles.main}
      >
        <Icon
          name={iconFor(entry.kind)}
          size={16}
          color={
            entry.kind === "directory" ? theme.colors.foreground : theme.colors.foregroundMuted
          }
        />
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.name}
          </Text>
          {modified ? (
            <Text style={styles.modified} numberOfLines={1}>
              {modified}
            </Text>
          ) : null}
        </View>
        <Text style={styles.size} numberOfLines={1}>
          {size}
        </Text>
      </Pressable>
      <View style={styles.trailing}>
        {isFile ? (
          <IconButton
            theme={theme}
            compact={compact}
            icon="Download"
            label={`Download ${entry.name}`}
            disabled={disabled}
            hidden={!showRowActions(hovered, selected, compact)}
            onPress={handleDownload}
            onHoverIn={handleHoverIn}
            onHoverOut={handleHoverOut}
          />
        ) : null}
      </View>
    </View>
  );
}
