import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { vpnProfileSchema, type SshVpnProfile } from "../shared/contracts";
import type { Theme } from "./types";
import {
  FONT_SIZE,
  IconButton,
  MIN_TOUCH_TARGET,
  ROW_HEIGHT,
  SectionHeader,
  SPACE,
  TextField,
} from "./ui-kit";

type Draft = SshVpnProfile;
type Field = keyof Draft;

const EMPTY: Draft = { name: "", script: "", openvpnPath: "", config: "", managementSocket: "" };

const FIELDS: { key: Field; placeholder: string }[] = [
  { key: "name", placeholder: "Name (e.g. gkg-prd)" },
  { key: "script", placeholder: "Path to vpn_session.sh" },
  { key: "openvpnPath", placeholder: "Path to the openvpn binary" },
  { key: "config", placeholder: "Path to the .ovpn config" },
  { key: "managementSocket", placeholder: "Path to the management socket" },
];

/** What the form below the list is doing: closed, adding, or editing the profile with this name. */
type FormState = { kind: "closed" } | { kind: "add" } | { kind: "edit"; name: string };

const CLOSED: FormState = { kind: "closed" };
const ADDING: FormState = { kind: "add" };

interface ProfileFormProps {
  theme: Theme;
  compact: boolean;
  disabled: boolean;
  /** Names already taken by other profiles. */
  takenNames: readonly string[];
  initial?: SshVpnProfile;
  onSubmit(profile: SshVpnProfile): Promise<boolean>;
  onCancel(): void;
}

function ProfileForm({
  theme,
  compact,
  disabled,
  takenNames,
  initial,
  onSubmit,
  onCancel,
}: ProfileFormProps) {
  const [draft, setDraft] = useState<Draft>(initial ?? EMPTY);
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
      hint: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
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
      error: { color: theme.colors.statusDanger, fontSize: FONT_SIZE.small },
    }),
    [theme, height, disabled],
  );
  const handleChange = useCallback((field: Field, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  }, []);
  const handleSave = useCallback(async () => {
    const parsed = vpnProfileSchema.safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${String(issue?.path[0] ?? "Profile")}: ${issue?.message ?? "is not valid"}`);
      return;
    }
    if (takenNames.includes(parsed.data.name)) {
      setError("A profile with that name already exists");
      return;
    }
    setError(null);
    await onSubmit(parsed.data);
  }, [draft, takenNames, onSubmit]);
  return (
    <View style={styles.form}>
      <Text style={styles.title}>{initial ? `Edit ${initial.name}` : "New VPN profile"}</Text>
      <Text style={styles.hint}>
        Absolute paths on the host that runs the daemon. The shared script opens the VPN when a host
        that uses this profile connects, and closes it about 2 minutes after the last user.
      </Text>
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
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save VPN profile"
          disabled={disabled}
          onPress={handleSave}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>Save profile</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={styles.ghost}
        >
          <Text style={styles.ghostText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface ProfileRowProps {
  theme: Theme;
  compact: boolean;
  disabled: boolean;
  profile: SshVpnProfile;
  onEdit(name: string): void;
  onRemove(name: string): void;
}

function ProfileRow({ theme, compact, disabled, profile, onEdit, onRemove }: ProfileRowProps) {
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minHeight: compact ? MIN_TOUCH_TARGET : ROW_HEIGHT,
        paddingHorizontal: SPACE.sm,
        gap: SPACE.sm,
      },
      text: { flex: 1, minWidth: 0 },
      name: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
      detail: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
    }),
    [theme, compact],
  );
  const handleEdit = useCallback(() => onEdit(profile.name), [onEdit, profile.name]);
  const handleRemove = useCallback(() => onRemove(profile.name), [onRemove, profile.name]);
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {profile.name}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {profile.config}
        </Text>
      </View>
      <IconButton
        theme={theme}
        compact={compact}
        icon="Pencil"
        label={`Edit VPN profile ${profile.name}`}
        disabled={disabled}
        onPress={handleEdit}
      />
      <IconButton
        theme={theme}
        compact={compact}
        icon="Trash2"
        tone="danger"
        label={`Remove VPN profile ${profile.name}`}
        disabled={disabled}
        onPress={handleRemove}
      />
    </View>
  );
}

interface VpnProfilesProps {
  theme: Theme;
  compact: boolean;
  /** False while settings are loading, saving, or unreadable. */
  disabled: boolean;
  profiles: readonly SshVpnProfile[];
  /** Adds a profile, or replaces `previousName`'s. */
  onSave(profile: SshVpnProfile, previousName?: string): Promise<boolean>;
  onRemove(name: string): Promise<boolean>;
}

/**
 * The VPN profiles hosts can name: a small list with add, edit, and remove. A profile says where
 * the shared on-demand VPN script, the openvpn binary, its config, and its management socket are.
 */
export function VpnProfiles({
  theme,
  compact,
  disabled,
  profiles,
  onSave,
  onRemove,
}: VpnProfilesProps) {
  const [form, setForm] = useState<FormState>(CLOSED);
  const styles = useMemo(
    () => ({
      header: { flexDirection: "row" as const, alignItems: "center" as const },
      grow: { flex: 1 },
      message: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.small,
        paddingHorizontal: SPACE.sm,
        paddingVertical: SPACE.xs,
      },
    }),
    [theme],
  );
  const toggleAdd = useCallback(() => {
    setForm((current) => (current.kind === "add" ? CLOSED : ADDING));
  }, []);
  const closeForm = useCallback(() => setForm(CLOSED), []);
  const handleEdit = useCallback((name: string) => setForm({ kind: "edit", name }), []);
  const handleRemove = useCallback(
    (name: string) => {
      void onRemove(name);
    },
    [onRemove],
  );
  const editedName = form.kind === "edit" ? form.name : undefined;
  const edited = editedName ? profiles.find((profile) => profile.name === editedName) : undefined;
  const takenNames = useMemo(
    () => profiles.map((profile) => profile.name).filter((name) => name !== editedName),
    [profiles, editedName],
  );
  const handleSubmit = useCallback(
    async (profile: SshVpnProfile) => {
      const done = await onSave(profile, editedName);
      if (done) setForm(CLOSED);
      return done;
    },
    [onSave, editedName],
  );
  return (
    <>
      <View style={styles.header}>
        <View style={styles.grow}>
          <SectionHeader theme={theme} title="VPN profiles" count={profiles.length} />
        </View>
        <IconButton
          theme={theme}
          compact={compact}
          icon="Plus"
          label="Add VPN profile"
          active={form.kind === "add"}
          disabled={disabled}
          onPress={toggleAdd}
        />
      </View>
      {form.kind === "add" ? (
        <ProfileForm
          theme={theme}
          compact={compact}
          disabled={disabled}
          takenNames={takenNames}
          onSubmit={handleSubmit}
          onCancel={closeForm}
        />
      ) : null}
      {edited ? (
        <ProfileForm
          key={edited.name}
          theme={theme}
          compact={compact}
          disabled={disabled}
          takenNames={takenNames}
          initial={edited}
          onSubmit={handleSubmit}
          onCancel={closeForm}
        />
      ) : null}
      {profiles.map((profile) => (
        <ProfileRow
          key={profile.name}
          theme={theme}
          compact={compact}
          disabled={disabled}
          profile={profile}
          onEdit={handleEdit}
          onRemove={handleRemove}
        />
      ))}
      {profiles.length === 0 && form.kind === "closed" ? (
        <Text style={styles.message}>
          None. A host can open a VPN on demand once you add a profile.
        </Text>
      ) : null}
    </>
  );
}
