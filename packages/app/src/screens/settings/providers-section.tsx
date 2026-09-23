import { useCallback, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildAcpProviderConfigPatch,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { ProviderCatalogList } from "@/components/provider-catalog-list";
import { getProviderIcon } from "@/components/provider-icons";
import { PaseoToolsPolicySheet } from "@/screens/settings/paseo-tools-policy-sheet";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ProviderConnectionSheet } from "@/components/provider-connection-sheet";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import {
  useFoundationProviderConnectionStatus,
  type FoundationProviderConnectionQualification,
} from "@/providers/use-foundation-provider-connection-status";
import { ChevronRight, MoreHorizontal, Settings2, Trash2 } from "lucide-react-native";
import { isPaseoSupportedProvider } from "@getpaseo/protocol/provider-config";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

function buildSupportedProviderDefinitions(
  entries: ProviderEntry[] | undefined,
  providers: MutableDaemonConfig["providers"] | undefined,
): ProviderDefinition[] {
  return buildProviderDefinitions(entries).filter((definition) =>
    isPaseoSupportedProvider(definition.id, providers?.[definition.id]),
  );
}

function requiresProviderConnectionQualification(
  entry: ProviderEntry,
  providers: MutableDaemonConfig["providers"] | undefined,
): boolean {
  return entry.source === "custom" && providers?.[entry.provider]?.extends === "codex";
}

function resolveProviderEnabledValue(
  providerId: string,
  entryEnabled: boolean | undefined,
  optimisticEnabled: Record<string, boolean>,
): boolean {
  return optimisticEnabled[providerId] ?? entryEnabled ?? true;
}

function shouldShowProviderList(input: {
  hasServer: boolean;
  isConnected: boolean;
  isLoading: boolean;
  providerCount: number;
}): boolean {
  return input.hasServer && input.isConnected && !input.isLoading && input.providerCount > 0;
}

type StatusTone = "success" | "warning" | "danger" | "muted" | "loading";

interface ProviderStatus {
  tone: StatusTone;
  label: string;
  modelCount: number | null;
}

function getProviderStatus(
  status: string,
  enabled: boolean,
  modelCount: number,
  requiresConnectionQualification: boolean,
  connectionQualification: FoundationProviderConnectionQualification,
  t: TFunction,
): ProviderStatus {
  if (!enabled)
    return { tone: "muted", label: t("settings.providers.statuses.disabled"), modelCount: null };
  if (status === "loading") {
    return { tone: "loading", label: t("settings.providers.statuses.loading"), modelCount: null };
  }
  if (status === "error") {
    return { tone: "danger", label: t("settings.providers.statuses.error"), modelCount: null };
  }
  if (requiresConnectionQualification) {
    if (connectionQualification === "qualified") {
      return {
        tone: "success",
        label: t("settings.providers.statuses.connectionQualified"),
        modelCount: null,
      };
    }
    if (connectionQualification === "stale") {
      return {
        tone: "warning",
        label: t("settings.providers.statuses.connectionQualificationStale"),
        modelCount: null,
      };
    }
    return {
      tone: "warning",
      label: t("settings.providers.statuses.connectionUnverified"),
      modelCount: null,
    };
  }
  if (status === "ready") {
    return {
      tone: "success",
      label: t("settings.providers.statuses.available"),
      modelCount: modelCount > 0 ? modelCount : null,
    };
  }
  return {
    tone: "warning",
    label: t("settings.providers.statuses.notInstalled"),
    modelCount: null,
  };
}

interface ProviderRowProps {
  serverId: string;
  def: ProviderDefinition;
  entry: ProviderEntry;
  enabled: boolean;
  isToggling: boolean;
  isRemoving: boolean;
  toggleError: string | null;
  canRemove: boolean;
  isFirst: boolean;
  canConfigureTools: boolean;
  requiresConnectionQualification: boolean;
  qualificationModel: string | null;
  supportsConnectionQualification: boolean;
  onPress: (providerId: string) => void;
  onToggleEnabled: (providerId: string, enabled: boolean) => void;
  onConfigureTools: (providerId: string) => void;
  onRemove: (providerId: string, providerLabel: string) => void;
}

function stopPressInPropagation(event: GestureResponderEvent) {
  event.stopPropagation();
}

interface ProviderActionsMenuProps {
  providerId: string;
  providerLabel: string;
  isRemoving: boolean;
  iconSize: number;
  foregroundColor: string;
  foregroundMutedColor: string;
  dangerColor: string;
  canRemove: boolean;
  canConfigureTools: boolean;
  onConfigureTools: (providerId: string) => void;
  onRemove: (providerId: string, providerLabel: string) => void;
}

function ProviderActionsMenu({
  providerId,
  providerLabel,
  isRemoving,
  iconSize,
  foregroundColor,
  foregroundMutedColor,
  dangerColor,
  canRemove,
  canConfigureTools,
  onConfigureTools,
  onRemove,
}: ProviderActionsMenuProps) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => {
    onRemove(providerId, providerLabel);
  }, [onRemove, providerId, providerLabel]);
  const handleConfigureTools = useCallback(() => {
    onConfigureTools(providerId);
  }, [onConfigureTools, providerId]);
  const triggerStyle = useCallback(
    ({
      pressed,
      hovered,
      open,
    }: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) => [
      styles.menuButton,
      (hovered || open) && styles.menuButtonHovered,
      pressed && styles.menuButtonPressed,
    ],
    [],
  );
  const trashLeading = useMemo(() => <Trash2 size={16} color={dangerColor} />, [dangerColor]);
  const settingsLeading = useMemo(
    () => <Settings2 size={16} color={foregroundMutedColor} />,
    [foregroundMutedColor],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={isRemoving}
        hitSlop={8}
        onPressIn={stopPressInPropagation}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.actions.menu", { name: providerLabel })}
        testID={`provider-actions-${providerId}`}
      >
        {({ hovered, open }) => (
          <MoreHorizontal
            size={iconSize}
            color={hovered || open ? foregroundColor : foregroundMutedColor}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {canConfigureTools ? (
          <DropdownMenuItem
            leading={settingsLeading}
            onSelect={handleConfigureTools}
            testID={`provider-configure-tools-${providerId}`}
          >
            {t("settings.providers.actions.configureTools")}
          </DropdownMenuItem>
        ) : null}
        {canRemove ? (
          <DropdownMenuItem
            destructive
            leading={trashLeading}
            onSelect={handleRemove}
            status={isRemoving ? "pending" : "idle"}
            pendingLabel={t("settings.providers.actions.removing")}
            testID={`provider-remove-${providerId}`}
          >
            {t("settings.providers.actions.remove")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderRow({
  serverId,
  def,
  entry,
  enabled,
  isToggling,
  isRemoving,
  toggleError,
  canRemove,
  isFirst,
  canConfigureTools,
  requiresConnectionQualification,
  qualificationModel,
  supportsConnectionQualification,
  onPress,
  onToggleEnabled,
  onConfigureTools,
  onRemove,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const ProviderIcon = getProviderIcon(def.id, serverId);
  const providerError =
    enabled &&
    entry.status === "error" &&
    typeof entry.error === "string" &&
    entry.error.trim().length > 0
      ? entry.error.trim()
      : null;
  const modelCount = filterSelectableModels(entry.models ?? null)?.length ?? 0;
  const connectionQualification = useFoundationProviderConnectionStatus({
    serverId,
    provider: def.id,
    model: qualificationModel,
    enabled: requiresConnectionQualification && supportsConnectionQualification,
    refreshKey: entry.fetchedAt,
  });
  const providerStatus = getProviderStatus(
    entry.status,
    enabled,
    modelCount,
    requiresConnectionQualification,
    connectionQualification,
    t,
  );

  const handlePress = useCallback(() => {
    onPress(def.id);
  }, [def.id, onPress]);
  const handleToggleValueChange = useCallback(
    (value: boolean) => {
      onToggleEnabled(def.id, value);
    },
    [def.id, onToggleEnabled],
  );
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      !isFirst && settingsStyles.rowBorder,
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("settings.providers.providerDetails", { name: def.label })}
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <View style={styles.rowContent}>
            <ChevronRight
              size={theme.iconSize.sm}
              color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
            <ProviderIcon size={theme.iconSize.md} color={theme.colors.foreground} />
            <View style={styles.textColumn}>
              <View style={styles.titleRow}>
                <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                  {def.label}
                </Text>
                {!isCompact ? <Text style={styles.separator}>·</Text> : null}
                <StatusIndicator status={providerStatus} compact={isCompact} />
              </View>
              {providerError && !isCompact ? (
                <Text style={styles.errorText} numberOfLines={3}>
                  {providerError}
                </Text>
              ) : null}
              {toggleError ? (
                <Text
                  style={styles.errorText}
                  numberOfLines={3}
                  testID={`provider-toggle-error-${def.id}`}
                >
                  {toggleError}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.trailingControls}>
            <Switch
              value={enabled}
              onValueChange={handleToggleValueChange}
              disabled={isToggling || isRemoving}
              accessibilityLabel={t("settings.providers.enableProvider", { name: def.label })}
              testID={`provider-enabled-${def.id}`}
            />
            {canConfigureTools || canRemove ? (
              <View style={styles.menuSlot}>
                <ProviderActionsMenu
                  providerId={def.id}
                  providerLabel={def.label}
                  isRemoving={isRemoving}
                  canRemove={canRemove}
                  canConfigureTools={canConfigureTools}
                  iconSize={theme.iconSize.sm}
                  foregroundColor={theme.colors.foreground}
                  foregroundMutedColor={theme.colors.foregroundMuted}
                  dangerColor={theme.colors.statusDanger}
                  onConfigureTools={onConfigureTools}
                  onRemove={onRemove}
                />
              </View>
            ) : null}
          </View>
        </>
      )}
    </Pressable>
  );
}

function getDotColor(tone: StatusTone, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

function StatusIndicator({ status, compact }: { status: ProviderStatus; compact: boolean }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const dotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: getDotColor(status.tone, theme) }],
    [status.tone, theme],
  );

  return (
    <View style={styles.statusRow}>
      {status.tone === "loading" ? (
        <LoadingSpinner size={10} color={theme.colors.foregroundMuted} />
      ) : (
        <View style={dotStyle} />
      )}
      {!compact ? (
        <>
          <Text style={styles.statusLabel}>{status.label}</Text>
          {status.modelCount !== null ? (
            <>
              <Text style={styles.separator}>·</Text>
              <Text style={styles.statusLabel}>
                {status.modelCount === 1
                  ? t("settings.providers.models.one")
                  : t("settings.providers.models.many", { count: status.modelCount })}
              </Text>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export interface ProvidersSectionProps {
  serverId: string;
}

function OpenAICompatibleProviderCard({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <View style={[settingsStyles.card, styles.compatibleProviderCard]}>
      <View style={styles.compatibleProviderCopy}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.providers.connection.openAICompatible")}
        </Text>
        <Text style={styles.compatibleProviderHint}>
          {t("settings.providers.connection.openAICompatibleHint")}
        </Text>
      </View>
      <Button variant="outline" size="sm" onPress={onOpen} testID="add-openai-compatible-provider">
        {t("settings.providers.connection.add")}
      </Button>
    </View>
  );
}

export function ProvidersSection({ serverId }: ProvidersSectionProps) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const supportsPaseoToolPolicies = useHostFeature(serverId, "paseoToolPolicies");
  const supportsFoundationCredentials = useHostFeature(serverId, "foundationCredentials");
  const supportsConnectionQualification = useHostFeature(
    serverId,
    "providerConnectionQualification",
  );
  const { entries, isLoading, refresh } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const openProviderSettings = useProviderSettingsStore((state) => state.open);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [optimisticEnabled, setOptimisticEnabled] = useState<Record<string, boolean>>({});
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const removingProviderIdRef = useRef<string | null>(null);
  const [installingProviderId, setInstallingProviderId] = useState<string | null>(null);
  const [toolPolicyProviderId, setToolPolicyProviderId] = useState<string | null>(null);
  const [toolPolicyVisible, setToolPolicyVisible] = useState(false);
  const [foundationProviderSheetOpen, setFoundationProviderSheetOpen] = useState(false);

  const providerDefinitions = useMemo(
    () => buildSupportedProviderDefinitions(entries, config?.providers),
    [config?.providers, entries],
  );
  const hasServer = serverId.length > 0;
  const showProviderList = shouldShowProviderList({
    hasServer,
    isConnected,
    isLoading,
    providerCount: providerDefinitions.length,
  });

  const handleOpenProviderSettings = useCallback(
    (providerId: string) => {
      openProviderSettings({ serverId, provider: providerId });
    },
    [openProviderSettings, serverId],
  );

  const handleToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      setPendingProviderId(providerId);
      setOptimisticEnabled((current) => ({ ...current, [providerId]: enabled }));
      setToggleErrors((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      try {
        await patchConfig({ providers: { [providerId]: { enabled } } });
        await refresh([providerId]);
      } catch (error) {
        setToggleErrors((current) => ({
          ...current,
          [providerId]: `${t("settings.providers.updateErrorTitle")}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }));
      } finally {
        setOptimisticEnabled((current) => {
          const next = { ...current };
          delete next[providerId];
          return next;
        });
        setPendingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, refresh, t],
  );

  const handleOpenToolPolicy = useCallback((providerId: string) => {
    setToolPolicyProviderId(providerId);
    setToolPolicyVisible(true);
  }, []);
  const handleCloseToolPolicy = useCallback(() => setToolPolicyVisible(false), []);
  const handleDismissToolPolicy = useCallback(() => setToolPolicyProviderId(null), []);
  const handleOpenFoundationProvider = useCallback(() => setFoundationProviderSheetOpen(true), []);
  const handleCloseFoundationProvider = useCallback(
    () => setFoundationProviderSheetOpen(false),
    [],
  );
  const handleFoundationProviderSaved = useCallback(
    async (providerId: string) => refresh([providerId]),
    [refresh],
  );

  const handleRemoveProvider = useCallback(
    async (providerId: string, providerLabel: string) => {
      if (removingProviderIdRef.current) return;
      removingProviderIdRef.current = providerId;
      setRemovingProviderId(providerId);
      try {
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message: t("settings.providers.remove.confirmMessage"),
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        await patchConfig({ removeProviders: [providerId] });
      } catch (error) {
        Alert.alert(
          t("settings.providers.remove.errorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (removingProviderIdRef.current === providerId) {
          removingProviderIdRef.current = null;
        }
        setRemovingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, t],
  );

  const handleInstall = useCallback(
    async (entry: AcpProviderCatalogItem) => {
      if (installingProviderId) return;
      setInstallingProviderId(entry.id);
      try {
        await patchConfig(buildAcpProviderConfigPatch(entry));
        await refresh([entry.id]);
      } catch (error) {
        Alert.alert(
          t("settings.providers.addErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setInstallingProviderId((current) => (current === entry.id ? null : current));
      }
    },
    [installingProviderId, patchConfig, refresh, t],
  );

  return (
    <>
      <SettingsSection
        title={t("settings.providers.title")}
        testID="host-page-providers-card"
        style={styles.sectionSpacing}
      >
        {hasServer && isConnected && !supportsPaseoToolPolicies ? (
          <InlineAlert
            variant="info"
            title={t("settings.providers.tools.updateRequired.title")}
            description={t("settings.providers.tools.updateRequired.description")}
            testID="provider-tools-update-required"
          />
        ) : null}
        {!hasServer || !isConnected ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
          </View>
        ) : null}
        {hasServer && isConnected && isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>{t("settings.providers.loading")}</Text>
          </View>
        ) : null}
        {showProviderList ? (
          <View style={settingsStyles.card}>
            {providerDefinitions.map((def, index) => {
              const entry = entries?.find((candidate) => candidate.provider === def.id);
              if (!entry) return null;
              return (
                <ProviderRow
                  key={def.id}
                  serverId={serverId}
                  def={def}
                  entry={entry}
                  enabled={resolveProviderEnabledValue(def.id, entry.enabled, optimisticEnabled)}
                  isToggling={pendingProviderId === def.id}
                  isRemoving={removingProviderId === def.id}
                  toggleError={toggleErrors[def.id] ?? null}
                  canRemove={supportsProviderRemoval && entry.source === "custom"}
                  isFirst={index === 0}
                  canConfigureTools={supportsPaseoToolPolicies}
                  qualificationModel={
                    entry.models?.find((model) => model.isDefault)?.id ??
                    entry.models?.[0]?.id ??
                    null
                  }
                  supportsConnectionQualification={supportsConnectionQualification}
                  requiresConnectionQualification={requiresProviderConnectionQualification(
                    entry,
                    config?.providers,
                  )}
                  onPress={handleOpenProviderSettings}
                  onToggleEnabled={handleToggleEnabled}
                  onConfigureTools={handleOpenToolPolicy}
                  onRemove={handleRemoveProvider}
                />
              );
            })}
          </View>
        ) : null}
      </SettingsSection>

      {hasServer && isConnected ? (
        <SettingsSection
          title={t("settings.providers.addProvider")}
          testID="host-page-add-provider-card"
          style={styles.addProviderSection}
        >
          <OpenAICompatibleProviderCard
            visible={supportsFoundationCredentials}
            onOpen={handleOpenFoundationProvider}
          />
          <ProviderCatalogList
            serverId={serverId}
            installingProviderId={installingProviderId}
            onInstall={handleInstall}
          />
        </SettingsSection>
      ) : null}
      {supportsPaseoToolPolicies && toolPolicyProviderId ? (
        <PaseoToolsPolicySheet
          providerId={toolPolicyProviderId}
          providerLabel={
            providerDefinitions.find((provider) => provider.id === toolPolicyProviderId)?.label ??
            toolPolicyProviderId
          }
          config={config}
          visible={toolPolicyVisible}
          onClose={handleCloseToolPolicy}
          onDismiss={handleDismissToolPolicy}
          patchConfig={patchConfig}
        />
      ) : null}
      {foundationProviderSheetOpen ? (
        <ProviderConnectionSheet
          key={`${serverId}:new-openai-compatible-provider`}
          mode="create"
          provider=""
          providerLabel=""
          modelId=""
          serverId={serverId}
          baseUrl=""
          credentialRef={null}
          canTestConnection={supportsConnectionQualification}
          onClose={handleCloseFoundationProvider}
          onSaved={handleFoundationProviderSaved}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  addProviderSection: {
    marginTop: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  compatibleProviderCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  compatibleProviderCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  compatibleProviderHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  row: {
    gap: theme.spacing[3],
    minHeight: 56,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  separator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  trailingControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  menuSlot: {
    width: 32,
    height: 32,
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  menuButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
