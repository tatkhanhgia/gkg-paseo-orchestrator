import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserComposerAttachment } from "@/attachments/types";
import type { TextReplacement } from "@/composer/types";
import type { DraftAgentControlsProps, DraftAgentTextFeature } from "@/composer/agent-controls";
import type { ExternalEffectCatalogEntry } from "@getpaseo/protocol/external-effect-catalog";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useRoleProfiles } from "@/hooks/use-role-profiles";
import {
  buildExternalEffectOptions,
  parseExternalEffects,
  summarizeExternalEffects,
} from "@/composer/draft/external-effects";
import {
  buildDraftAgentControls,
  hasDraftContent,
  resolveDraftKey,
  type DraftKeyInput,
} from "@/composer/draft/input-draft-core";
import {
  buildDraftCommandConfig,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  type ProviderSelectionState,
} from "@/provider-selection/provider-selection";
import { useDraftStore } from "@/stores/draft-store";
import { toDraftInputIfReady } from "@/stores/draft-store/state";
import {
  isProviderRoleBindingSupportedForRole,
  type PaseoRoleId,
} from "@getpaseo/protocol/role-binding";
import {
  assignmentExternalEffectBoundaryFor,
  isAssignmentEffectAllowedForRole,
  type AssignmentEffectClass,
} from "@getpaseo/protocol/assignment-contract";
import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { isWeb } from "@/constants/platform";
import {
  isRoleSelectionAvailable,
  resolvePinnedModeSelection,
  resolveRequiredModeIdForRoleBinding,
} from "@/composer/draft/effective-agent-modes";
import {
  defaultAssignmentEffectForRole,
  ordinaryAssignmentAuthorityOptionsForRole,
} from "@/workspace-protocol/assignment-authority";
import { resolveRoleOptions } from "@/workspace-protocol/legacy-role-options";

/** Stable identity keeps the feature memo from re-running on every render of a catalog-less host. */
const EMPTY_EXTERNAL_EFFECT_CATALOG: readonly ExternalEffectCatalogEntry[] = [];

function useExternalEffectCatalog(serverId: string | null): readonly ExternalEffectCatalogEntry[] {
  const { config } = useDaemonConfig(serverId);
  return config?.externalEffectCatalog ?? EMPTY_EXTERNAL_EFFECT_CATALOG;
}

const ASSIGNMENT_EFFECT_FEATURE_ID = "foundation_assignment_effect";
const BEADS_ISSUE_GRANT_FEATURE_ID = "foundation_beads_issue_grant";
const EXTERNAL_EFFECTS_GRANT_FEATURE_ID = "foundation_external_effects_grant";

export function resolveRolePinnedModeTransition(input: {
  selectedMode: string;
  requiredModeId: string | null;
  rememberedModeId: string | undefined;
  modeOptionIds: readonly string[];
}): {
  rememberModeId?: string;
  applyModeId?: string;
  clearRememberedMode: boolean;
} {
  const selectedMode = input.selectedMode.trim();
  const requiredModeId = input.requiredModeId?.trim() ?? "";
  const rememberedModeId = input.rememberedModeId?.trim() ?? "";

  if (requiredModeId) {
    if (selectedMode === requiredModeId) {
      return { clearRememberedMode: false };
    }
    return {
      ...(selectedMode ? { rememberModeId: selectedMode } : {}),
      applyModeId: requiredModeId,
      clearRememberedMode: false,
    };
  }

  if (!rememberedModeId) {
    return { clearRememberedMode: false };
  }
  if (input.modeOptionIds.length === 0) {
    return { clearRememberedMode: false };
  }
  if (!input.modeOptionIds.includes(rememberedModeId)) {
    return { clearRememberedMode: true };
  }
  return {
    ...(selectedMode !== rememberedModeId ? { applyModeId: rememberedModeId } : {}),
    clearRememberedMode: true,
  };
}

export interface BeadsIssueGrantOption {
  id: string;
  label: string;
}

type AttachmentUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

interface AgentInputDraftComposerOptions {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  initialFeatureValues?: Record<string, unknown>;
  isVisible?: boolean;
  onlineServerIds?: string[];
  lockedWorkingDir?: string;
  beadsIssueOptions?: readonly BeadsIssueGrantOption[];
  initialRoleId?: PaseoRoleId | null;
  initialAssignmentEffect?: AssignmentEffectClass;
  initialBeadsIssueIds?: readonly string[];
}

interface UseAgentInputDraftInput {
  draftKey: DraftKeyInput;
  composer?: AgentInputDraftComposerOptions;
}

function resolveInitialRoleState(composerOptions: AgentInputDraftComposerOptions | null): {
  roleId: PaseoRoleId | null;
  assignmentEffect: AssignmentEffectClass;
  beadsIssueIds: readonly string[] | undefined;
} {
  const initialRole = composerOptions?.initialRoleId;
  const initialEffect =
    composerOptions?.initialAssignmentEffect ??
    (initialRole ? defaultAssignmentEffectForRole(initialRole) : "read-only");
  return {
    roleId: initialRole ?? null,
    assignmentEffect:
      initialRole && isAssignmentEffectAllowedForRole(initialRole, initialEffect)
        ? initialEffect
        : "read-only",
    beadsIssueIds: composerOptions?.initialBeadsIssueIds,
  };
}

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown> | undefined;
  agentControls: DraftAgentControlsProps;
  commandDraftConfig: DraftCommandConfig | undefined;
  selectedRole: PaseoRoleId | null;
  setRoleFromUser: (roleId: PaseoRoleId) => void;
  selectedAssignmentEffect: AssignmentEffectClass;
  selectedBeadsIssueIds: string[];
  selectedExternalEffects: string[];
};

export interface AgentInputDraft {
  text: string;
  editText: (text: string) => void;
  replaceText: (text: string) => void;
  textReplacement: TextReplacement;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
  attachmentFocusRequestId: number;
  composerState: DraftComposerState | null;
}

function useBeadsIssueGrantControl(
  selectedRole: PaseoRoleId | null,
  issueOptions: readonly BeadsIssueGrantOption[] | undefined,
  initialIssueIds: readonly string[] | undefined,
) {
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(() => {
    const initialIssueId = initialIssueIds?.[0]?.trim() ?? "";
    return initialIssueId || null;
  });
  const feature = useMemo<AgentFeature | null>(
    () =>
      selectedRole === "peer"
        ? {
            type: "select",
            id: BEADS_ISSUE_GRANT_FEATURE_ID,
            label: "Peer issue grant",
            description: "Exact durable Beads issue leased to this Peer assignment.",
            value: selectedIssueId,
            options: [...(issueOptions ?? [])],
          }
        : null,
    [issueOptions, selectedIssueId, selectedRole],
  );

  useEffect(() => {
    if (selectedRole !== "peer") {
      setSelectedIssueId(null);
      return;
    }
  }, [selectedRole]);

  const setFromFeatureValue = useCallback(
    (value: unknown) => {
      const issueId = typeof value === "string" ? value.trim() : "";
      setSelectedIssueId(issueOptions?.some((option) => option.id === issueId) ? issueId : null);
    },
    [issueOptions],
  );

  return {
    feature,
    selectedIssueIds: selectedIssueId ? [selectedIssueId] : [],
    setFromFeatureValue,
  };
}

function useExternalEffectsGrantControl(
  selectedRole: PaseoRoleId | null,
  selectedAssignmentEffect: AssignmentEffectClass,
  catalog: readonly ExternalEffectCatalogEntry[],
) {
  const [value, setValue] = useState("");
  const isAvailable = selectedRole
    ? assignmentExternalEffectBoundaryFor(selectedRole, selectedAssignmentEffect).mode === "bounded"
    : false;
  const selectedExternalEffects = useMemo(() => parseExternalEffects(value), [value]);
  const feature = useMemo<DraftAgentTextFeature | null>(
    () =>
      isAvailable
        ? {
            type: "text",
            id: EXTERNAL_EFFECTS_GRANT_FEATURE_ID,
            label: "External access",
            description:
              "Outside-workspace resources this assignment may touch (DB, API, service). One per line.",
            value,
            summary: summarizeExternalEffects(selectedExternalEffects),
            options: buildExternalEffectOptions(catalog, value),
          }
        : null,
    [catalog, isAvailable, selectedExternalEffects, value],
  );

  const setFromFeatureValue = useCallback((nextValue: unknown) => {
    setValue(typeof nextValue === "string" ? nextValue : "");
  }, []);
  const clear = useCallback(() => setValue(""), []);

  return { feature, selectedExternalEffects, setFromFeatureValue, clear };
}

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const { t } = useTranslation();
  const composerOptions = input.composer ?? null;
  const initialRoleState = resolveInitialRoleState(composerOptions);
  const formState = useAgentFormState({
    initialServerId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
    onlineServerIds: composerOptions?.onlineServerIds ?? [],
  });
  const roleProfiles = useRoleProfiles(formState.selectedServerId);
  const externalEffectCatalog = useExternalEffectCatalog(formState.selectedServerId);
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const draftRecord = useDraftStore((state) => state.drafts[draftKey]);
  const draft = useMemo(() => toDraftInputIfReady(draftRecord), [draftRecord]);
  const attachmentFocusRequestId = useDraftStore(
    (state) => state.attachmentFocusRequestByDraftKey[draftKey] ?? 0,
  );
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<PaseoRoleId | null>(initialRoleState.roleId);
  const [selectedAssignmentEffect, setSelectedAssignmentEffect] = useState<AssignmentEffectClass>(
    initialRoleState.assignmentEffect,
  );
  const rolePinnedModeRestoreByProviderRef = useRef(new Map<string, string>());
  const beadsIssueGrant = useBeadsIssueGrantControl(
    selectedRole,
    composerOptions?.beadsIssueOptions,
    initialRoleState.beadsIssueIds,
  );
  const externalEffectsGrant = useExternalEffectsGrantControl(
    selectedRole,
    selectedAssignmentEffect,
    externalEffectCatalog,
  );
  const text = draft?.text ?? "";
  const attachments = draft?.attachments ?? [];
  const isHydrated = hydratedDraftKey === draftKey;
  const textReplacementRevisionRef = useRef(0);
  const [textReplacement, setTextReplacement] = useState<TextReplacement>(() => ({
    key: `${draftKey}:0`,
    text,
  }));

  const publishTextReplacement = useCallback(
    (nextText: string) => {
      textReplacementRevisionRef.current += 1;
      setTextReplacement({
        key: `${draftKey}:${textReplacementRevisionRef.current}`,
        text: nextText,
      });
    },
    [draftKey],
  );

  const saveDraft = useCallback(
    (
      update: (draft: { text: string; attachments: UserComposerAttachment[] }) => {
        text: string;
        attachments: UserComposerAttachment[];
      },
    ) => {
      const store = useDraftStore.getState();
      const current = store.getDraftInput(draftKey) ?? { text: "", attachments: [] };
      const next = update(current);
      if (!hasDraftContent(next)) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
        return;
      }
      store.saveDraftInput({ draftKey, draft: next });
    },
    [draftKey],
  );

  const textPublication = useMemo(
    () =>
      new AfterPaintPublication<string>((nextText) => {
        saveDraft((current) => ({ ...current, text: nextText }));
      }),
    [saveDraft],
  );

  const editText = useCallback(
    (nextText: string) => {
      if (isWeb) {
        textPublication.stage(nextText);
      } else {
        saveDraft((current) => ({ ...current, text: nextText }));
      }
    },
    [saveDraft, textPublication],
  );

  const replaceText = useCallback(
    (nextText: string) => {
      textPublication.cancel();
      saveDraft((current) => ({ ...current, text: nextText }));
      publishTextReplacement(nextText);
    },
    [publishTextReplacement, saveDraft, textPublication],
  );

  const setAttachments = useCallback(
    (updater: AttachmentUpdater) => {
      saveDraft((current) => ({
        ...current,
        attachments: typeof updater === "function" ? updater(current.attachments) : updater,
      }));
    },
    [saveDraft],
  );

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      textPublication.cancel();
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle });
    },
    [draftKey, textPublication],
  );

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") textPublication.flush();
    };
    const flush = () => textPublication.flush();
    const canListenForPageHide =
      isWeb && typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", flushWhenHidden);
    }
    if (canListenForPageHide) {
      window.addEventListener("pagehide", flush);
    }
    return () => {
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", flushWhenHidden);
      }
      if (canListenForPageHide) {
        window.removeEventListener("pagehide", flush);
      }
      textPublication.flush();
    };
  }, [textPublication]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await useDraftStore.getState().hydrateDraftInput({ draftKey });
      if (!cancelled) {
        const hydratedText = useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
        publishTextReplacement(hydratedText);
        setHydratedDraftKey(draftKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey, publishTextReplacement]);

  const lockedWorkingDir = composerOptions?.lockedWorkingDir?.trim() ?? "";
  useEffect(() => {
    if (!composerOptions || !lockedWorkingDir) {
      return;
    }
    if (formState.workingDir.trim() === lockedWorkingDir) {
      return;
    }
    formState.setWorkingDir(lockedWorkingDir);
  }, [composerOptions, formState, lockedWorkingDir]);

  const providerSelection = useMemo<ProviderSelectionState>(
    () => ({
      provider: formState.selectedProvider,
      modelId: formState.selectedModel,
      modeId: formState.selectedMode,
      thinkingOptionId: formState.selectedThinkingOptionId,
      availableModels: formState.availableModels,
      modeOptions: formState.modeOptions,
    }),
    [
      formState.availableModels,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedModel,
      formState.selectedProvider,
      formState.selectedThinkingOptionId,
    ],
  );

  const effectiveModelId = useMemo(
    () => resolveEffectiveComposerModelId(providerSelection),
    [providerSelection],
  );

  const effectiveThinkingOptionId = useMemo(
    () => resolveEffectiveComposerThinkingOptionId(providerSelection, effectiveModelId),
    [effectiveModelId, providerSelection],
  );

  const workingDir = lockedWorkingDir || formState.workingDir;
  const allProviderEntries = formState.allProviderEntries;
  const selectedProvider = formState.selectedProvider;
  const setModeFromUser = formState.setModeFromUser;
  const setProviderAndModelFromUser = formState.setProviderAndModelFromUser;
  const setProviderAndModelForRole = formState.setProviderAndModelForRole;
  useEffect(() => {
    if (!selectedRole) {
      return;
    }
    const entries = allProviderEntries ?? [];
    if (!entries.some((entry) => entry.roleBinding !== undefined)) {
      return;
    }
    const selectedEntry = entries.find((entry) => entry.provider === selectedProvider);
    if (isProviderRoleBindingSupportedForRole(selectedEntry?.roleBinding, selectedRole)) {
      const requiredModeId = resolveRequiredModeIdForRoleBinding(
        selectedAssignmentEffect,
        selectedEntry?.roleBinding,
      );
      if (selectedProvider) {
        const transition = resolveRolePinnedModeTransition({
          selectedMode: formState.selectedMode,
          requiredModeId,
          rememberedModeId: rolePinnedModeRestoreByProviderRef.current.get(selectedProvider),
          modeOptionIds: formState.modeOptions.map((mode) => mode.id),
        });
        if (transition.rememberModeId) {
          rolePinnedModeRestoreByProviderRef.current.set(
            selectedProvider,
            transition.rememberModeId,
          );
        }
        if (transition.clearRememberedMode) {
          rolePinnedModeRestoreByProviderRef.current.delete(selectedProvider);
        }
        if (transition.applyModeId) {
          if (requiredModeId) {
            setProviderAndModelForRole(
              selectedProvider,
              formState.selectedModel,
              transition.applyModeId,
            );
          } else {
            setModeFromUser(transition.applyModeId);
          }
        }
      }
      return;
    }
    const compatible = entries.find(
      (entry) =>
        entry.enabled !== false &&
        entry.status === "ready" &&
        isProviderRoleBindingSupportedForRole(entry.roleBinding, selectedRole),
    );
    if (compatible) {
      const requiredModeId = resolveRequiredModeIdForRoleBinding(
        selectedAssignmentEffect,
        compatible.roleBinding,
      );
      if (requiredModeId) {
        setProviderAndModelForRole(compatible.provider, "", requiredModeId);
      } else {
        setProviderAndModelFromUser(compatible.provider, "");
      }
    }
  }, [
    allProviderEntries,
    formState.selectedMode,
    formState.selectedModel,
    formState.modeOptions,
    selectedAssignmentEffect,
    selectedProvider,
    selectedRole,
    setModeFromUser,
    setProviderAndModelForRole,
    setProviderAndModelFromUser,
  ]);

  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
    applyProfileFeatureValues,
  } = useDraftAgentFeatures({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
    initialFeatureValues: composerOptions?.initialFeatureValues,
  });
  const assignmentEffectFeature = useMemo<AgentFeature | null>(
    () =>
      selectedRole
        ? {
            type: "select",
            id: ASSIGNMENT_EFFECT_FEATURE_ID,
            label: "Assignment authority",
            description: "What this role may do for this assignment. Fixed after launch.",
            value: selectedAssignmentEffect,
            options: [...ordinaryAssignmentAuthorityOptionsForRole(selectedRole)],
          }
        : null,
    [selectedAssignmentEffect, selectedRole],
  );
  const setRoleAndNormalizeEffect = useCallback(
    (roleId: PaseoRoleId) => {
      setSelectedRole(roleId);
      const shouldResetEffect =
        roleId !== selectedRole ||
        !isAssignmentEffectAllowedForRole(roleId, selectedAssignmentEffect);
      const nextEffect = shouldResetEffect
        ? defaultAssignmentEffectForRole(roleId)
        : selectedAssignmentEffect;
      if (shouldResetEffect) {
        setSelectedAssignmentEffect(nextEffect);
      }
      if (assignmentExternalEffectBoundaryFor(roleId, nextEffect).mode === "denied") {
        externalEffectsGrant.clear();
      }
    },
    [externalEffectsGrant, selectedAssignmentEffect, selectedRole],
  );
  const setAgentControlFeature = useCallback(
    (featureId: string, value: unknown) => {
      if (featureId === ASSIGNMENT_EFFECT_FEATURE_ID) {
        const selected = selectedRole
          ? ordinaryAssignmentAuthorityOptionsForRole(selectedRole).find(
              (option) => option.id === value,
            )
          : undefined;
        if (
          selectedRole &&
          selected &&
          isAssignmentEffectAllowedForRole(selectedRole, selected.id)
        ) {
          setSelectedAssignmentEffect(selected.id);
          if (assignmentExternalEffectBoundaryFor(selectedRole, selected.id).mode === "denied") {
            externalEffectsGrant.clear();
          }
        }
        return;
      }
      if (featureId === BEADS_ISSUE_GRANT_FEATURE_ID) {
        beadsIssueGrant.setFromFeatureValue(value);
        return;
      }
      if (featureId === EXTERNAL_EFFECTS_GRANT_FEATURE_ID) {
        externalEffectsGrant.setFromFeatureValue(value);
        return;
      }
      setDraftFeatureValue(featureId, value);
    },
    [beadsIssueGrant, externalEffectsGrant, selectedRole, setDraftFeatureValue],
  );

  const applyDraftAgentProfile = useCallback(
    (profile: Parameters<typeof formState.applyProfileFromUser>[0]) => {
      formState.applyProfileFromUser(profile);
      applyProfileFeatureValues(profile.provider as AgentProvider, profile.featureValues);
    },
    [applyProfileFeatureValues, formState],
  );

  const commandDraftConfig = useMemo(
    () =>
      composerOptions
        ? buildDraftCommandConfig({
            selection: providerSelection,
            cwd: workingDir,
            effectiveModelId,
            effectiveThinkingOptionId,
            featureValues: draftFeatureValues,
          })
        : undefined,
    [
      composerOptions,
      effectiveModelId,
      effectiveThinkingOptionId,
      draftFeatureValues,
      providerSelection,
      workingDir,
    ],
  );

  // Hoisted above the composerState memo so the same lock state can both gate
  // `setModeFromUser` (suppressing a contradictory selection outright) and shape
  // the returned mode options/selection in the same render pass.
  const roleOptions = useMemo(
    () => resolveRoleOptions(roleProfiles.catalog, roleProfiles.supported),
    [roleProfiles.catalog, roleProfiles.supported],
  );
  const roleSelectionAvailable = isRoleSelectionAvailable(
    formState.allProviderEntries,
    roleOptions.length,
  );
  const requiredNoWriteModeIdForSelection = useMemo(() => {
    if (!roleSelectionAvailable || !selectedRole) return null;
    const entry = formState.allProviderEntries?.find(
      (candidate) => candidate.provider === formState.selectedProvider,
    );
    return resolveRequiredModeIdForRoleBinding(selectedAssignmentEffect, entry?.roleBinding);
  }, [
    roleSelectionAvailable,
    selectedRole,
    selectedAssignmentEffect,
    formState.allProviderEntries,
    formState.selectedProvider,
  ]);
  const guardedSetModeFromUser = useCallback(
    (modeId: string) => {
      // A locked assignment offers exactly one mode; reject anything else outright
      // instead of forwarding a contradictory choice the daemon will overrule anyway.
      if (requiredNoWriteModeIdForSelection && modeId !== requiredNoWriteModeIdForSelection) {
        return;
      }
      setModeFromUser(modeId);
    },
    [requiredNoWriteModeIdForSelection, setModeFromUser],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    const compatibleProviderIds = new Set(
      (formState.allProviderEntries ?? [])
        .filter((entry) => isProviderRoleBindingSupportedForRole(entry.roleBinding, selectedRole))
        .map((entry) => entry.provider),
    );
    const roleAwareFormState =
      roleSelectionAvailable && selectedRole
        ? {
            ...formState,
            providerDefinitions: formState.providerDefinitions.filter((definition) =>
              compatibleProviderIds.has(definition.id),
            ),
            modelSelectorProviders: formState.modelSelectorProviders.filter((provider) =>
              compatibleProviderIds.has(provider.id),
            ),
          }
        : formState;

    // Narrow the offered modes to what the daemon will actually allow once this
    // no-write role binding launches, so the picker never shows a mode that is
    // certain to be rejected (UX-03). When the provider's declared modes do not
    // include the pinned id, show one explicit locked entry rather than falling
    // back to the full (forbidden) list, and project the selection to match it
    // immediately so modeOptions/selectedMode never disagree on this render.
    const pinnedSelection = resolvePinnedModeSelection(
      roleAwareFormState.modeOptions,
      requiredNoWriteModeIdForSelection,
      t,
    );
    const effectiveFormState = pinnedSelection
      ? {
          ...roleAwareFormState,
          modeOptions: pinnedSelection.modeOptions,
          selectedMode: pinnedSelection.selectedMode,
          setModeFromUser: guardedSetModeFromUser,
        }
      : { ...roleAwareFormState, setModeFromUser: guardedSetModeFromUser };

    return {
      ...effectiveFormState,
      workingDir,
      effectiveModelId,
      effectiveThinkingOptionId,
      featureValues: draftFeatureValues,
      agentControls: {
        ...buildDraftAgentControls({
          formState: effectiveFormState,
          roleOptions: roleSelectionAvailable ? roleOptions : [],
          selectedRole: roleSelectionAvailable ? selectedRole : null,
          onSelectRole: setRoleAndNormalizeEffect,
          modeLockReason: pinnedSelection?.lockReason,
          features:
            roleSelectionAvailable && (assignmentEffectFeature || beadsIssueGrant.feature)
              ? [
                  ...(draftFeatures ?? []),
                  ...(assignmentEffectFeature ? [assignmentEffectFeature] : []),
                  ...(beadsIssueGrant.feature ? [beadsIssueGrant.feature] : []),
                ]
              : draftFeatures,
          onSetFeature: setAgentControlFeature,
          onApplyAgentProfile: applyDraftAgentProfile,
        }),
        draftTextFeatures:
          roleSelectionAvailable && externalEffectsGrant.feature
            ? [externalEffectsGrant.feature]
            : undefined,
      },
      commandDraftConfig,
      selectedRole: roleSelectionAvailable ? selectedRole : null,
      setRoleFromUser: setRoleAndNormalizeEffect,
      selectedAssignmentEffect,
      selectedBeadsIssueIds: beadsIssueGrant.selectedIssueIds,
      selectedExternalEffects: externalEffectsGrant.selectedExternalEffects,
    };
  }, [
    commandDraftConfig,
    composerOptions,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftFeatures,
    assignmentEffectFeature,
    beadsIssueGrant,
    externalEffectsGrant,
    draftFeatureValues,
    applyDraftAgentProfile,
    formState,
    guardedSetModeFromUser,
    requiredNoWriteModeIdForSelection,
    roleOptions,
    roleSelectionAvailable,
    selectedRole,
    selectedAssignmentEffect,
    setAgentControlFeature,
    setRoleAndNormalizeEffect,
    t,
    workingDir,
  ]);

  return {
    text,
    editText,
    replaceText,
    textReplacement,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  };
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftCommandConfig,
  buildDraftComposerCommandConfig: buildDraftCommandConfig,
  buildDraftAgentControls,
};
