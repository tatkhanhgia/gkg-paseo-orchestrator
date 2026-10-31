import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkspaceOption } from "../shared/workspaces";
import { MIN_TOUCH_TARGET } from "./file-row";
import type { Theme } from "./types";

const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };
const EXPANDED = { expanded: true };
const COLLAPSED = { expanded: false };

interface OptionRowProps {
  theme: Theme;
  option: WorkspaceOption;
  selected: boolean;
  onChoose(option: WorkspaceOption): void;
}

function OptionRow({ theme, option, selected, onChoose }: OptionRowProps) {
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      text: { flex: 1, minWidth: 0 },
      label: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
  const handlePress = useCallback(() => onChoose(option), [onChoose, option]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Use workspace ${option.label}`}
      accessibilityState={selected ? SELECTED : NOT_SELECTED}
      onPress={handlePress}
      style={styles.row}
    >
      <View style={styles.text}>
        <Text style={styles.label} numberOfLines={1}>
          {option.label}
        </Text>
        {option.directory ? (
          <Text style={styles.detail} numberOfLines={1}>
            {option.directory}
          </Text>
        ) : null}
      </View>
      {selected ? <Icon name="Check" size={16} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

interface WorkspacePickerProps {
  theme: Theme;
  options: readonly WorkspaceOption[];
  selected: WorkspaceOption | null;
  loading: boolean;
  error: string | null;
  onChoose(workspaceId: string): void;
  onRefresh(): void;
}

/** Picks the workspace that receives terminals, downloads, and uploads. */
export function WorkspacePicker({
  theme,
  options,
  selected,
  loading,
  error,
  onChoose,
  onRefresh,
}: WorkspacePickerProps) {
  const [open, setOpen] = useState(false);
  const styles = useMemo(
    () => ({
      box: { gap: 6 },
      heading: { color: theme.colors.foregroundMuted },
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? theme.colors.border : theme.colors.accent,
      },
      buttonText: { flex: 1, minWidth: 0, color: theme.colors.foreground },
      list: {
        borderWidth: 1,
        borderRadius: 8,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, selected],
  );
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const handleChoose = useCallback(
    (option: WorkspaceOption) => {
      onChoose(option.id);
      setOpen(false);
    },
    [onChoose],
  );
  const title = selected?.label ?? (loading ? "Loading workspaces…" : "Choose a workspace");
  return (
    <View style={styles.box}>
      <Text style={styles.heading}>Target workspace</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Target workspace: ${title}`}
        accessibilityState={open ? EXPANDED : COLLAPSED}
        onPress={toggle}
        style={styles.button}
      >
        <Text style={styles.buttonText} numberOfLines={1}>
          {title}
        </Text>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={16}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {open ? (
        <View style={styles.list}>
          {options.map((option) => (
            <OptionRow
              key={option.id}
              theme={theme}
              option={option}
              selected={option.id === selected?.id}
              onChoose={handleChoose}
            />
          ))}
          {options.length === 0 && !loading ? (
            <Text style={styles.muted}>No workspaces found on this host.</Text>
          ) : null}
        </View>
      ) : null}
      {!selected && !loading && !error ? (
        <Text style={styles.muted}>
          Connect, download, and upload need a workspace: terminals open in it, downloads land in
          its directory, and uploads read from it.
        </Text>
      ) : null}
      {error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reload workspaces"
          onPress={onRefresh}
        >
          <Text style={styles.error}>{error} Tap to retry.</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
