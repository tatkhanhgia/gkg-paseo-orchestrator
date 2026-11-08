import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { SshUserHost } from "../shared/contracts";
import { parseNewUserHost } from "../shared/hosts";
import type { Theme } from "./types";
import { FONT_SIZE, MIN_TOUCH_TARGET, ROW_HEIGHT, SPACE, TextField } from "./ui-kit";

type NewHost = Omit<SshUserHost, "id">;

const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

interface HostFormProps {
  theme: Theme;
  compact: boolean;
  disabled: boolean;
  /** Names of the VPN profiles a host can open. */
  vpnProfiles: readonly string[];
  /** The host being edited; omitted when adding. */
  initial?: SshUserHost;
  onSubmit(host: NewHost): Promise<boolean>;
  onCancel(): void;
  /** Offered while editing. */
  onDelete?(): void;
}

const EMPTY = { label: "", host: "", user: "", port: "", identityFile: "", vpnProfile: "" };
type Draft = typeof EMPTY;

const FIELDS: { key: Exclude<keyof Draft, "vpnProfile">; placeholder: string }[] = [
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
    vpnProfile: initial.vpnProfile ?? "",
  };
}

interface VpnChoiceProps {
  theme: Theme;
  /** The profile name, or empty for "no VPN". */
  value: string;
  selected: boolean;
  label: string;
  minHeight: number;
  onSelect(value: string): void;
}

function VpnChoice({ theme, value, selected, label, minHeight, onSelect }: VpnChoiceProps) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const style = useMemo(
    () => ({
      minHeight,
      justifyContent: "center" as const,
      paddingHorizontal: SPACE.md,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: selected ? theme.colors.accent : theme.colors.border,
      backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
    }),
    [theme, selected, minHeight],
  );
  const textStyle = useMemo(
    () => ({
      color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
      fontSize: FONT_SIZE.body,
    }),
    [theme, selected],
  );
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`VPN: ${label}`}
      accessibilityState={selected ? SELECTED : NOT_SELECTED}
      onPress={handlePress}
      style={style}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

/** Adds a saved host, or edits one. The primary button is the form's one call to action. */
export function HostForm({
  theme,
  compact,
  disabled,
  vpnProfiles,
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
      choices: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: SPACE.sm },
      hint: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
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
  const handleVpnChoice = useCallback(
    (value: string) => handleChange("vpnProfile", value),
    [handleChange],
  );
  // A host may still name a profile that was removed; keep it visible so saving does not drop it.
  const choices = useMemo(
    () =>
      draft.vpnProfile && !vpnProfiles.includes(draft.vpnProfile)
        ? [...vpnProfiles, draft.vpnProfile]
        : vpnProfiles,
    [vpnProfiles, draft.vpnProfile],
  );
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
        <TextField
          key={key}
          field={key}
          placeholder={placeholder}
          value={draft[key]}
          style={styles.input}
          placeholderColor={theme.colors.foregroundMuted}
          onChange={handleChange}
        />
      ))}
      <Text style={styles.hint}>VPN to open for this host (set up under VPN profiles)</Text>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        <VpnChoice
          theme={theme}
          value=""
          selected={draft.vpnProfile === ""}
          label="None"
          minHeight={height}
          onSelect={handleVpnChoice}
        />
        {choices.map((name) => (
          <VpnChoice
            key={name}
            theme={theme}
            value={name}
            selected={draft.vpnProfile === name}
            label={vpnProfiles.includes(name) ? name : `${name} (missing)`}
            minHeight={height}
            onSelect={handleVpnChoice}
          />
        ))}
      </View>
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
