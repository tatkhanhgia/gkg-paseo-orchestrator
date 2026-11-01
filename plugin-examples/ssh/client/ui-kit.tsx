import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { Theme } from "./types";

/** Smallest comfortable touch target on a phone, in points. */
export const MIN_TOUCH_TARGET = 44;
/** The spacing scale: every padding and gap on the SSH screen is one of these. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16 } as const;
export const FONT_SIZE = { small: 12, body: 13, title: 15 } as const;
/** Height of a one-line row in the wide layout. */
export const ROW_HEIGHT = 32;
const ICON_BUTTON_SIZE = 28;
const ICON_SIZE = 16;
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

/** Hover never fires on a touch screen, so hover-to-show controls show there all the time. */
export const isTouchPlatform = Platform.OS !== "web";

/** Whether a row shows its action buttons: hovered, selected, or on a touch or compact layout. */
export function showRowActions(hovered: boolean, selected: boolean, compact: boolean): boolean {
  return hovered || selected || compact || isTouchPlatform;
}

/** Hover state for a pressable. It stays false on touch screens, which have no hover. */
export function useHover(onHoverIn?: () => void, onHoverOut?: () => void) {
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => {
    setHovered(true);
    onHoverIn?.();
  }, [onHoverIn]);
  const handleHoverOut = useCallback(() => {
    setHovered(false);
    onHoverOut?.();
  }, [onHoverOut]);
  return { hovered, handleHoverIn, handleHoverOut };
}

function buttonOpacity(hidden: boolean, disabled: boolean): number {
  if (hidden) return 0;
  return disabled ? 0.4 : 1;
}

interface IconButtonProps {
  theme: Theme;
  icon: string;
  /** The accessible name; there is no visible text. */
  label: string;
  onPress(): void;
  disabled?: boolean;
  /** Phones get a 44-point target; wide layouts a 28-point one. */
  compact?: boolean;
  /** Shows the button as switched on, e.g. while its panel is open. */
  active?: boolean;
  /** Fades the button out but keeps it in the layout and the accessibility tree. */
  hidden?: boolean;
  tone?: "default" | "danger";
  onHoverIn?(): void;
  onHoverOut?(): void;
}

/** A borderless icon button. The only chrome is a subtle fill on hover. */
export function IconButton({
  theme,
  icon,
  label,
  onPress,
  disabled = false,
  compact = false,
  active = false,
  hidden = false,
  tone = "default",
  onHoverIn,
  onHoverOut,
}: IconButtonProps) {
  const { hovered, handleHoverIn, handleHoverOut } = useHover(onHoverIn, onHoverOut);
  const size = compact ? MIN_TOUCH_TARGET : ICON_BUTTON_SIZE;
  const styles = useMemo(
    () => ({
      button: {
        width: size,
        height: size,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 6,
        backgroundColor: hovered || active ? theme.colors.border : "transparent",
        opacity: buttonOpacity(hidden, disabled),
      },
    }),
    [theme, size, hovered, active, hidden, disabled],
  );
  const color = tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active ? SELECTED : NOT_SELECTED}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={styles.button}
    >
      <Icon
        name={icon}
        size={ICON_SIZE}
        color={hovered || active ? theme.colors.foreground : color}
      />
    </Pressable>
  );
}

interface SegmentButtonProps<Value extends string> {
  theme: Theme;
  value: Value;
  label: string;
  icon: string;
  selected: boolean;
  compact: boolean;
  onSelect(value: Value): void;
}

function SegmentButton<Value extends string>({
  theme,
  value,
  label,
  icon,
  selected,
  compact,
  onSelect,
}: SegmentButtonProps<Value>) {
  const styles = useMemo(
    () => ({
      segment: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: SPACE.xs + 2,
        minHeight: compact ? MIN_TOUCH_TARGET - SPACE.sm : ROW_HEIGHT - SPACE.xs,
        borderRadius: 6,
        backgroundColor: selected ? theme.colors.surface0 : "transparent",
      },
      label: {
        color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.body,
        fontWeight: selected ? ("600" as const) : ("400" as const),
      },
    }),
    [theme, selected, compact],
  );
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={selected ? SELECTED : NOT_SELECTED}
      onPress={handlePress}
      style={styles.segment}
    >
      <Icon
        name={icon}
        size={ICON_SIZE - 2}
        color={selected ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

interface SegmentedControlProps<Value extends string> {
  theme: Theme;
  segments: readonly { value: Value; label: string; icon: string }[];
  value: Value;
  compact: boolean;
  onChange(value: Value): void;
}

/** A pill-shaped switch between a few views; the chosen one is raised. */
export function SegmentedControl<Value extends string>({
  theme,
  segments,
  value,
  compact,
  onChange,
}: SegmentedControlProps<Value>) {
  const styles = useMemo(
    () => ({
      track: {
        flexDirection: "row" as const,
        padding: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
    }),
    [theme],
  );
  return (
    <View accessibilityRole="tablist" style={styles.track}>
      {segments.map((segment) => (
        <SegmentButton
          key={segment.value}
          theme={theme}
          value={segment.value}
          label={segment.label}
          icon={segment.icon}
          selected={segment.value === value}
          compact={compact}
          onSelect={onChange}
        />
      ))}
    </View>
  );
}

interface SectionHeaderProps {
  theme: Theme;
  title: string;
  count?: number;
}

/** A small, quiet heading above a group of rows. */
export function SectionHeader({ theme, title, count }: SectionHeaderProps) {
  const styles = useMemo(
    () => ({
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACE.xs + 2,
        paddingHorizontal: SPACE.sm,
        paddingTop: SPACE.md,
        paddingBottom: SPACE.xs,
      },
      title: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.4,
        textTransform: "uppercase" as const,
      },
    }),
    [theme],
  );
  return (
    <View accessibilityRole="header" style={styles.header}>
      <Text style={styles.title}>{count === undefined ? title : `${title} · ${count}`}</Text>
    </View>
  );
}

interface StatusDotProps {
  color: string;
  size?: number;
}

export function StatusDot({ color, size = 8 }: StatusDotProps) {
  const style = useMemo(
    () => ({ width: size, height: size, borderRadius: size / 2, backgroundColor: color }),
    [color, size],
  );
  return <View style={style} />;
}
