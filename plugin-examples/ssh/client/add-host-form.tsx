import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SshUserHost } from "../shared/contracts";
import { parseNewUserHost } from "../shared/hosts";

type NewHost = Omit<SshUserHost, "id">;

interface AddHostFormProps {
  theme: PluginSurfaceProps["theme"];
  disabled: boolean;
  onAdd(host: NewHost): Promise<boolean>;
  onCancel(): void;
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

export function AddHostForm({ theme, disabled, onAdd, onCancel }: AddHostFormProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const styles = useMemo(
    () => ({
      form: { gap: 8 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        padding: 10,
        color: theme.colors.foreground,
      },
      row: { flexDirection: "row" as const, gap: 8 },
      button: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
      secondary: { padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
      secondaryText: { color: theme.colors.foreground },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
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
    if (await onAdd(result.host)) setDraft(EMPTY);
  }, [draft, onAdd]);
  return (
    <View style={styles.form}>
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
          style={styles.button}
        >
          <Text style={styles.buttonText}>Save host</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={styles.secondary}
        >
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
