import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import type { AssignmentEffectClass } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export function claimDraftAutoSubmit(
  claim: { current: string | null },
  submitKey: string,
): boolean {
  if (claim.current === submitKey) return false;
  claim.current = submitKey;
  return true;
}

export interface WorkspaceDraftRoleContext {
  roleId: PaseoRoleId | null;
  assignmentEffect: AssignmentEffectClass;
  beadsIssueIds: readonly string[];
}

export function resolveWorkspaceDraftRoleContext(input: {
  autoSubmitContext: WorkspaceDraftRoleContext | null;
  composerContext: WorkspaceDraftRoleContext;
}): WorkspaceDraftRoleContext {
  return input.autoSubmitContext ?? input.composerContext;
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  hasClient: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
