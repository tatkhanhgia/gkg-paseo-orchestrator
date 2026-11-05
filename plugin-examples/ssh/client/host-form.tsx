import { TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SshUserHost } from "../shared/contracts";
import { parseNewUserHost } from "../shared/hosts";
import type { Theme } from "./types";
import { FONT_SIZE, MIN_TOUCH_TARGET, ROW_HEIGHT, SPACE } from "./ui-kit";

type NewHost = Omit<SshUserHost, "id">;

interface HostFormProps {
  theme: Theme;
  compact: boolean;
  disabled: boolean;
  /** The host being edited; omitted when adding. */
  initial?: SshUserHost;
  onSubmit(host: NewHost): Promise<boolean>;
  onCancel(): void;
  /** Offered while editing. */
  onDelete?(): void;
}

const EMPTY = { label: "", host: "", user: "", port: "", identityFile: "" };
type Draft = typeof EMPTY;

const FIELDS: { key: keyof Draft; placeholder: string }[] = [
  { key: "label", placeholder: "Label (e.g. build server)" },
  { key: "host", placeholder: "Host or address" },
  { key: "user", placeholder: "User (optional)" },
  { key: "port", placeholder: "Port (optional)" },
  { key: "identityFile", placeholder: "Identity file path (optional, never contents)" },
];

function draftOf(initial: SshUserHost | undefined): Draft {
  if (!initial) return EMPTY;
  return {
    label: initial.label,
    host: initial.host,
    user: initial.user ?? "",
    port: initial.port === undefined ? "" : String(initial.port),
    identityFile: initial.identityFile ?? "",
  };
}

function DraftInput({
  field,
  placeholder,
  value,
  style,
  placeholderColor,
  onChange,
}: {
  field: keyof Draft;
  placeholder: string;
  value: string;
  style: object;
  placeholderColor: string;
  onChange(field: keyof Draft, value: string): void;
}) {
  const handleChange = useCallback((text: string) => onChange(field, text), [field, onChange]);
  return (
    <TextInput
      accessibilityLabel={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={placeholder}
      placeholderTextColor={placeholderColor}
      value={value}
      onChangeText={handleChange}
      style={style}
    />
  );
}

/** Adds a saved host, or edits one. The primary button is the form's one call to action. */
export function HostForm({
  theme,
  compact,
  disabled,
  initial,
  onSubmit,
  onCancel,
  onDelete,
}: HostFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [error, setError] = useState<string | null>(null);
  const height = compact ? MIN_TOUCH_TARGET : ROW_HEIGHT;
  const styles = useMemo(
    () => ({
      form: {
        gap: SPACE.sm,
        padding: SPACE.md,
        marginHorizontal: SPACE.sm,
        marginBottom: SPACE.sm,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: FONT_SIZE.body,
        fontWeight: "600" as const,
      },
      input: {
        minHeight: height,
        paddingHorizontal: SPACE.sm + 2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        color: theme.colors.foreground,
        fontSize: FONT_SIZE.body,
        backgroundColor: theme.colors.surface1,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: SPACE.sm },
      spacer: { flex: 1 },
      primary: {
        minHeight: height,
        justifyContent: "center" as const,
        paddingHorizontal: SPACE.md,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
        opacity: disabled ? 0.5 : 1,
      },
      primaryText: { color: theme.colors.accentForeground, fontSize: FONT_SIZE.body },
      ghost: {
        minHeight: height,
        justifyContent: "center" as const,
        paddingHorizontal: SPACE.md,
        borderRadius: 6,
      },
      ghostText: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
      dangerText: { color: theme.colors.statusDanger, fontSize: FONT_SIZE.body },
      error: { color: theme.colors.statusDanger, fontSize: FONT_SIZE.small },
    }),
    [theme, height, disabled],
  );
  const handleChange = useCallback((field: keyof Draft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  }, []);
  const handleSave = useCallback(async () => {
    const result = parseNewUserHost(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    if (await onSubmit(result.host)) setDraft(EMPTY);
  }, [draft, onSubmit]);
  return (
    <View style={styles.form}>
      <Text style={styles.title}>{initial ? `Edit ${initial.label}` : "New host"}</Text>
      {FIELDS.map(({ key, placeholder }) => (
        <DraftInput
          key={key}
          field={key}
          placeholder={placeholder}
          value={draft[key]}
          style={styles.input}
          placeholderColor={theme.colors.foregroundMuted}
          onChange={handleChange}
        />
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save host"
          disabled={disabled}
          onPress={handleSave}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>Save host</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={styles.ghost}
        >
          <Text style={styles.ghostText}>Cancel</Text>
        </Pressable>
        {onDelete ? (
          <>
            <View style={styles.spacer} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete host"
              disabled={disabled}
              onPress={onDelete}
              style={styles.ghost}
            >
              <Text style={styles.dangerText}>Delete</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}
