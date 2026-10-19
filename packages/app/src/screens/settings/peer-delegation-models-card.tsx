import { useCallback, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { ArrowDown, ArrowUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type {
  AgentProfile,
  MutableDaemonConfigPatch,
  PeerSubrole,
} from "@getpaseo/protocol/messages";
import { resolvePeerDelegationProviderPriority } from "@getpaseo/protocol/peer-delegation-priority";
import { isPeerDelegationProviderAdmitted } from "@getpaseo/protocol/provider-config";
import { AgentProfileGlyph } from "@/agent-profiles";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

const RUN_MODE_OPTIONS = [
  { value: "guarded", label: "Guarded", testID: "peer-run-mode-guarded" },
  { value: "unattended", label: "Unattended", testID: "peer-run-mode-unattended" },
] as const;

type PeerDefaultSubroleSelection = PeerSubrole | "exact";

const DEFAULT_SUBROLE_OPTIONS: SelectFieldOption<PeerDefaultSubroleSelection>[] = [
  {
    id: "exact",
    value: "exact",
    label: "Require exact profile",
    description: "Lead must pass launchProfileId when more than one profile is allowed.",
    testID: "peer-default-subrole-exact",
  },
  {
    id: "scout",
    value: "scout",
    label: "Scout",
    description: "Generic Peer calls use the highest-priority Scout profile.",
    testID: "peer-default-subrole-scout",
  },
  {
    id: "engineer",
    value: "engineer",
    label: "Engineer",
    description: "Generic Peer calls use the highest-priority Engineer profile.",
    testID: "peer-default-subrole-engineer",
  },
  {
    id: "reviewer",
    value: "reviewer",
    label: "Reviewer",
    description: "Generic Peer calls use the highest-priority Reviewer profile.",
    testID: "peer-default-subrole-reviewer",
  },
  {
    id: "architect",
    value: "architect",
    label: "Architect",
    description: "Generic Peer calls use the highest-priority Architect profile.",
    testID: "peer-default-subrole-architect",
  },
];

function peerSubroleLabel(subrole: PeerSubrole): string {
  return `${subrole.slice(0, 1).toUpperCase()}${subrole.slice(1)}`;
}

interface ProfilePresentation {
  summary: string;
  available: boolean;
  unavailableReason?: string;
}

const EMPTY_PROFILES: readonly AgentProfile[] = [];
const EMPTY_PROFILE_IDS: readonly string[] = [];

function buildProfileSummary(
  profile: AgentProfile,
  entry: ProviderSnapshotEntry | undefined,
  modelLabel: string,
): string {
  const labels = [entry?.label ?? profile.provider, modelLabel];
  if (profile.peerSubrole) labels.unshift(`Peer ${peerSubroleLabel(profile.peerSubrole)}`);
  if (profile.modeId) labels.push(profile.modeId);
  if (profile.thinkingOptionId) labels.push(profile.thinkingOptionId);
  const featureCount = Object.keys(profile.featureValues ?? {}).length;
  if (featureCount > 0) labels.push(`${featureCount} feature${featureCount === 1 ? "" : "s"}`);
  return labels.join(" · ");
}

function presentProfile(
  profile: AgentProfile,
  entries: readonly ProviderSnapshotEntry[] | undefined,
  providers: MutableDaemonConfigPatch["providers"],
): ProfilePresentation {
  const modelId = profile.model?.trim();
  if (!modelId) {
    return { summary: profile.provider, available: false, unavailableReason: "Model required" };
  }
  const entry = entries?.find((candidate) => candidate.provider === profile.provider);
  if (
    !isPeerDelegationProviderAdmitted({
      providerId: profile.provider,
      override: providers?.[profile.provider],
      roleBinding: entry?.roleBinding,
    })
  ) {
    return {
      summary: `${profile.provider} · ${modelId}`,
      available: false,
      unavailableReason: "Provider cannot run Paseo tools",
    };
  }
  const model = entry?.models?.find((candidate) => candidate.id === modelId);
  const available = entry?.enabled !== false && entry?.status === "ready" && model !== undefined;
  return {
    summary: buildProfileSummary(profile, entry, model?.label ?? modelId),
    available,
    ...(available ? {} : { unavailableReason: "Provider or model is unavailable" }),
  };
}

function PeerProfilePolicyRow({
  profile,
  presentation,
  selected,
  disabled,
  onChange,
}: {
  profile: AgentProfile;
  presentation: ProfilePresentation;
  selected: boolean;
  disabled: boolean;
  onChange: (profileId: string, selected: boolean) => void;
}) {
  const handleChange = useCallback(
    (next: boolean) => onChange(profile.id, next),
    [onChange, profile.id],
  );
  return (
    <View style={styles.profileRow} testID={`peer-profile-row-${profile.id}`}>
      <View style={styles.profileGlyph}>
        <AgentProfileGlyph icon={profile.icon} color={profile.color} size={ICON_SIZE.md} />
      </View>
      <View style={styles.profileCopy}>
        <Text style={styles.profileName}>{profile.name}</Text>
        <Text style={styles.profileSummary}>{presentation.summary}</Text>
        {profile.notes ? <Text style={styles.profileNotes}>{profile.notes}</Text> : null}
        {!presentation.available && presentation.unavailableReason ? (
          <Text style={styles.unavailable}>{presentation.unavailableReason}</Text>
        ) : null}
      </View>
      <Switch
        value={selected}
        onValueChange={handleChange}
        disabled={disabled}
        accessibilityLabel={`${selected ? "Disallow" : "Allow"} Peer profile ${profile.name}`}
        testID={`peer-profile-${profile.id}`}
      />
    </View>
  );
}

function ProviderPriorityRow({
  provider,
  label,
  rank,
  isFirst,
  isLast,
  disabled,
  onMove,
}: {
  provider: string;
  label: string;
  rank: number;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMove: (provider: string, offset: -1 | 1) => void;
}) {
  const handleMoveUp = useCallback(() => onMove(provider, -1), [onMove, provider]);
  const handleMoveDown = useCallback(() => onMove(provider, 1), [onMove, provider]);
  return (
    <View style={styles.priorityRow} testID={`peer-provider-priority-${provider}`}>
      <Text style={styles.priorityRank}>{rank}</Text>
      <View style={styles.priorityCopy}>
        <Text style={styles.profileName}>{label}</Text>
        {label !== provider ? <Text style={styles.profileSummary}>{provider}</Text> : null}
      </View>
      <View style={styles.priorityActions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={disabled || isFirst}
          accessibilityLabel={`Move ${label} up in Peer provider priority`}
          testID={`peer-provider-priority-up-${provider}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={disabled || isLast}
          accessibilityLabel={`Move ${label} down in Peer provider priority`}
          testID={`peer-provider-priority-down-${provider}`}
        />
      </View>
    </View>
  );
}

export function PeerDelegationProfilesCard({ serverId }: { serverId: string }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const isSupported = useHostFeature(serverId, "peerDelegationProfiles");
  const prioritySupported = useHostFeature(serverId, "peerDelegationProviderPriority");
  const defaultSubroleSupported = useHostFeature(serverId, "peerDelegationDefaultSubrole");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const policy = config?.peerDelegation ?? {
    enabled: false,
    allowedModels: [],
    runMode: "unattended" as const,
  };
  const profiles = config?.agentProfiles ?? EMPTY_PROFILES;
  const selectedProfileIds = config?.peerDelegationProfileIds ?? EMPTY_PROFILE_IDS;
  const selectedIds = useMemo(() => new Set(selectedProfileIds), [selectedProfileIds]);
  const providerPriority = useMemo(
    () =>
      resolvePeerDelegationProviderPriority(
        profiles,
        selectedProfileIds,
        config?.peerDelegationProviderPriority,
      ),
    [config?.peerDelegationProviderPriority, profiles, selectedProfileIds],
  );
  const defaultSubroleSelection = config?.peerDelegationDefaultSubrole ?? "exact";
  const defaultSubroleDisplay = useMemo<SelectFieldDisplay>(() => {
    const option = DEFAULT_SUBROLE_OPTIONS.find(
      (candidate) => candidate.value === defaultSubroleSelection,
    );
    return {
      label: option?.label ?? defaultSubroleSelection,
      ...(option?.description ? { description: option.description } : {}),
    };
  }, [defaultSubroleSelection]);

  const savePatch = useCallback(
    async (patch: MutableDaemonConfigPatch, key: string) => {
      setSavingKey(key);
      try {
        await patchConfig(patch);
      } catch (error) {
        Alert.alert(
          "Could not save Peer profile policy",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setSavingKey(null);
      }
    },
    [patchConfig],
  );

  const handleEnabledChange = useCallback(
    (enabled: boolean) => void savePatch({ peerDelegation: { enabled } }, "enabled"),
    [savePatch],
  );

  const handleProfileChange = useCallback(
    (profileId: string, selected: boolean) => {
      const nextIds = selected
        ? profiles
            .filter((profile) => selectedIds.has(profile.id) || profile.id === profileId)
            .map((profile) => profile.id)
        : selectedProfileIds.filter((id) => id !== profileId);
      const nextPriority = resolvePeerDelegationProviderPriority(
        profiles,
        nextIds,
        providerPriority,
      );
      void savePatch(
        {
          peerDelegationProfileIds: nextIds,
          ...(prioritySupported ? { peerDelegationProviderPriority: nextPriority } : {}),
          peerDelegation: { enabled: true },
        },
        profileId,
      );
    },
    [prioritySupported, profiles, providerPriority, savePatch, selectedIds, selectedProfileIds],
  );

  const handlePriorityMove = useCallback(
    (provider: string, offset: -1 | 1) => {
      const index = providerPriority.indexOf(provider);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= providerPriority.length) return;
      const nextPriority = [...providerPriority];
      const [item] = nextPriority.splice(index, 1);
      nextPriority.splice(target, 0, item);
      void savePatch({ peerDelegationProviderPriority: nextPriority }, `priority-${provider}`);
    },
    [providerPriority, savePatch],
  );

  const handleRunModeChange = useCallback(
    (runMode: "guarded" | "unattended") =>
      void savePatch({ peerDelegation: { runMode } }, "run-mode"),
    [savePatch],
  );

  const handleDefaultSubroleChange = useCallback(
    (value: PeerDefaultSubroleSelection) =>
      void savePatch(
        { peerDelegationDefaultSubrole: value === "exact" ? null : value },
        "default-subrole",
      ),
    [savePatch],
  );

  if (!isSupported) {
    return (
      <View style={[settingsStyles.card, styles.card]} testID="peer-delegation-profiles-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Lead → Peer profiles</Text>
            <Text style={settingsStyles.rowHint}>
              Update the daemon to configure Peer delegation with Agent Profiles.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[settingsStyles.card, styles.card]} testID="peer-delegation-profiles-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Allow Lead → Peer delegation</Text>
          <Text style={settingsStyles.rowHint}>
            Lead can launch only the Agent Profiles selected below. Subrole, profile notes, and
            provider priority guide routing; an empty selection blocks new Peers.
          </Text>
        </View>
        <Switch
          value={policy.enabled}
          onValueChange={handleEnabledChange}
          disabled={savingKey !== null}
          accessibilityLabel={`${policy.enabled ? "Disable" : "Enable"} Lead to Peer delegation`}
          testID="peer-delegation-policy-enabled"
        />
      </View>
      {policy.enabled ? (
        <>
          <View style={[settingsStyles.row, styles.runModeRow]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Peer runtime</Text>
              <Text style={settingsStyles.rowHint}>
                Guarded may pause at provider approval boundaries. Unattended requires a qualified
                no-prompt mode and fails closed when none exists.
              </Text>
            </View>
            <SegmentedControl
              options={[...RUN_MODE_OPTIONS]}
              value={policy.runMode}
              onValueChange={handleRunModeChange}
              size="sm"
              testID="peer-run-mode"
            />
          </View>
          <View style={[settingsStyles.row, styles.defaultSubroleRow]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Default generic Peer</Text>
              <Text style={settingsStyles.rowHint}>
                Used only when Lead omits launchProfileId. The daemon resolves the matching profile
                from the first configured provider and records the exact choice.
              </Text>
            </View>
            {defaultSubroleSupported ? (
              <View style={styles.defaultSubroleControl}>
                <SelectField
                  label="Default generic Peer"
                  value={defaultSubroleSelection}
                  selectedDisplay={defaultSubroleDisplay}
                  options={DEFAULT_SUBROLE_OPTIONS}
                  onChange={handleDefaultSubroleChange}
                  placeholder="Require exact profile"
                  emptyText="No Peer subroles available"
                  disabled={savingKey !== null}
                  searchable={false}
                  title="Default generic Peer"
                  size="sm"
                  field={false}
                  testID="peer-default-subrole-field"
                  triggerTestID="peer-default-subrole-trigger"
                />
              </View>
            ) : (
              <Text style={styles.priorityUnavailable}>
                Update the daemon to configure a generic Peer default.
              </Text>
            )}
          </View>
          {providerPriority.length > 0 ? (
            <View style={styles.prioritySection} testID="peer-provider-priority-list">
              <View style={styles.priorityHeader}>
                <Text style={settingsStyles.rowTitle}>Provider priority</Text>
                <Text style={settingsStyles.rowHint}>
                  Lead chooses a matching profile from the earliest suitable provider, then launches
                  that exact profile.
                </Text>
              </View>
              {prioritySupported ? (
                providerPriority.map((provider, index) => (
                  <ProviderPriorityRow
                    key={provider}
                    provider={provider}
                    label={
                      entries?.find((candidate) => candidate.provider === provider)?.label ??
                      provider
                    }
                    rank={index + 1}
                    isFirst={index === 0}
                    isLast={index === providerPriority.length - 1}
                    disabled={savingKey !== null}
                    onMove={handlePriorityMove}
                  />
                ))
              ) : (
                <Text style={styles.priorityUnavailable}>
                  Update the daemon to configure Peer provider priority.
                </Text>
              )}
            </View>
          ) : null}
          <View style={styles.profileList} testID="peer-delegation-profile-list">
            {profiles.map((profile) => {
              const presentation = presentProfile(profile, entries, config?.providers);
              const selected = selectedIds.has(profile.id);
              return (
                <PeerProfilePolicyRow
                  key={profile.id}
                  profile={profile}
                  presentation={presentation}
                  selected={selected}
                  disabled={savingKey !== null || (!selected && !presentation.available)}
                  onChange={handleProfileChange}
                />
              );
            })}
            {profiles.length === 0 ? (
              <Text style={styles.empty}>
                Create an Agent Profile below, then return here to allow it for Peer delegation.
              </Text>
            ) : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { overflow: "hidden" },
  runModeRow: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  defaultSubroleRow: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  defaultSubroleControl: {
    width: 230,
    maxWidth: "45%",
  },
  profileList: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  prioritySection: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  priorityHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  priorityRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  priorityRank: {
    width: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  priorityCopy: { flex: 1, minWidth: 0 },
  priorityActions: { flexDirection: "row", alignItems: "center" },
  priorityUnavailable: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  profileRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  profileGlyph: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  profileSummary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  profileNotes: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  unavailable: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
}));
