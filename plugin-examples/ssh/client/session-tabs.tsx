import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Theme } from "./types";
import { FONT_SIZE, IconButton, MIN_TOUCH_TARGET, SPACE, showRowActions, useHover } from "./ui-kit";

const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };
const TAB_HEIGHT = 36;
const MAX_TAB_WIDTH = 220;

interface SessionTabsProps {
  theme: Theme;
  compact: boolean;
  sessions: readonly { id: string; name: string }[];
  /** The shown session; `null` while none is shown. */
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  /** The "+" at the end: start another session. */
  onNew(): void;
}

interface TabProps {
  theme: Theme;
  compact: boolean;
  id: string;
  name: string;
  active: boolean;
  onSelect(id: string): void;
  onClose(id: string): void;
}

/** The terminal name is `ssh <label>`; the tab shows the label, the accessible name the whole. */
function tabLabel(name: string): string {
  return name.startsWith("ssh ") ? name.slice("ssh ".length) : name;
}

function Tab({ theme, compact, id, name, active, onSelect, onClose }: TabProps) {
  const { hovered, handleHoverIn, handleHoverOut } = useHover();
  const styles = useMemo(
    () => ({
      tab: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        maxWidth: MAX_TAB_WIDTH,
        height: compact ? MIN_TOUCH_TARGET : TAB_HEIGHT,
        borderTopWidth: 2,
        borderTopColor: active ? theme.colors.accent : "transparent",
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        backgroundColor: active || hovered ? theme.colors.surface0 : "transparent",
      },
      main: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.sm,
        height: "100%" as const,
        paddingLeft: SPACE.md,
      },
      label: {
        flexShrink: 1,
        color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.body,
        fontWeight: active ? ("600" as const) : ("400" as const),
      },
    }),
    [theme, compact, active, hovered],
  );
  const handleSelect = useCallback(() => onSelect(id), [id, onSelect]);
  const handleClose = useCallback(() => onClose(id), [id, onClose]);
  return (
    <View style={styles.tab}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={name}
        accessibilityState={active ? SELECTED : NOT_SELECTED}
        onPress={handleSelect}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={styles.main}
      >
        <Icon
          name="Terminal"
          size={14}
          color={active ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
        <Text style={styles.label} numberOfLines={1}>
          {tabLabel(name)}
        </Text>
      </Pressable>
      <IconButton
        theme={theme}
        compact={compact}
        icon="X"
        label={`Close ${name}`}
        hidden={!showRowActions(hovered, active, compact)}
        onPress={handleClose}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      />
    </View>
  );
}

/** The open sessions as tabs, with a "+" after them. Closing a tab ends its ssh. */
export function SessionTabs({
  theme,
  compact,
  sessions,
  activeId,
  onSelect,
  onClose,
  onNew,
}: SessionTabsProps) {
  const styles = useMemo(
    () => ({
      strip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      scroller: { flex: 1, minWidth: 0 },
      tabs: { alignItems: "center" as const },
      plus: { paddingHorizontal: SPACE.xs },
    }),
    [theme],
  );
  return (
    <View style={styles.strip}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroller}
        contentContainerStyle={styles.tabs}
      >
        {sessions.map((session) => (
          <Tab
            key={session.id}
            theme={theme}
            compact={compact}
            id={session.id}
            name={session.name}
            active={session.id === activeId}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </ScrollView>
      <View style={styles.plus}>
        <IconButton
          theme={theme}
          compact={compact}
          icon="Plus"
          label="New session"
          onPress={onNew}
        />
      </View>
    </View>
  );
}
