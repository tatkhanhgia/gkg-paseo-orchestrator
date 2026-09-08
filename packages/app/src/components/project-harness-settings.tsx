import { useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import type {
  ProjectHarnessApplyPayload,
  ProjectHarnessChange,
  ProjectHarnessInspectPayload,
  ProjectHarnessInspection,
  ProjectHarnessMutationResult,
  ProjectHarnessNotebookReleasePayload,
  ProjectHarnessOperation,
  ProjectHarnessPlan,
  ProjectHarnessPreviewPayload,
  ProjectHarnessRpcError,
  ProjectHarnessUpdatePayload,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { SettingsSection } from "@/screens/settings/settings-section";
import type { WorkspaceSummary } from "@/utils/projects";
import {
  acceptProjectHarnessCommit,
  describeProjectHarnessChange,
  isProjectHarnessPlanConsumed,
  projectHarnessTargetKey,
  resolveProjectHarnessNotebookReleaseSelectors,
  type ProjectHarnessCommitState,
  type ProjectHarnessReadbackState,
  type ProjectHarnessNotebookReleaseSelectors,
  summarizeProjectHarnessInspection,
} from "./project-harness-settings-model";

type HarnessMutationPayload = ProjectHarnessApplyPayload | ProjectHarnessUpdatePayload;

interface HarnessMutationOutcome {
  response: HarnessMutationPayload;
  freshInspection: ProjectHarnessInspectPayload | null;
  commit: ProjectHarnessCommitState<ProjectHarnessMutationResult> | null;
}

type HarnessReleaseReceipt = Extract<ProjectHarnessNotebookReleasePayload, { ok: true }>["result"];

interface HarnessReleaseOutcome {
  response: ProjectHarnessNotebookReleasePayload;
  freshInspection: ProjectHarnessInspectPayload | null;
  commit: ProjectHarnessCommitState<HarnessReleaseReceipt> | null;
}

export interface ProjectHarnessSettingsProps {
  client: DaemonClient;
  serverId: string;
  projectId: string;
  workspaces: readonly WorkspaceSummary[];
  supported: boolean;
}

export function ProjectHarnessSettings({
  client,
  serverId,
  projectId,
  workspaces,
  supported,
}: ProjectHarnessSettingsProps) {
  const { t } = useTranslation();
  let content: ReactNode;
  if (!supported) {
    content = (
      <Alert
        testID="project-harness-unsupported"
        variant="info"
        title={t("settings.project.projectHarness.unsupportedTitle")}
        description={t("settings.project.projectHarness.unsupportedDescription")}
      />
    );
  } else if (workspaces.length === 0) {
    content = (
      <Alert
        testID="project-harness-no-workspace"
        variant="info"
        title={t("settings.project.projectHarness.noWorkspaceTitle")}
        description={t("settings.project.projectHarness.noWorkspaceDescription")}
      />
    );
  } else {
    content = workspaces.map((workspace, index) => (
      <ProjectHarnessWorkspaceSection
        key={projectHarnessTargetKey(serverId, projectId, workspace.id)}
        client={client}
        serverId={serverId}
        projectId={projectId}
        workspace={workspace}
        last={index === workspaces.length - 1}
      />
    ));
  }

  return (
    <SettingsGroup
      title={t("settings.project.projectHarness.title")}
      info={t("settings.project.projectHarness.info")}
      testID="project-harness-group"
    >
      {content}
    </SettingsGroup>
  );
}

function ProjectHarnessWorkspaceSection({
  client,
  serverId,
  projectId,
  workspace,
  last,
}: {
  client: DaemonClient;
  serverId: string;
  projectId: string;
  workspace: WorkspaceSummary;
  last: boolean;
}) {
  const queryClient = useQueryClient();
  const targetKey = projectHarnessTargetKey(serverId, projectId, workspace.id);
  const queryKey = ["project-harness", serverId, projectId, workspace.id] as const;
  const query = useFetchQuery({
    queryKey,
    queryFn: () =>
      client.inspectProjectHarness({
        projectId,
        workspaceId: workspace.id,
      }),
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const [preview, setPreview] = useState<ProjectHarnessPreviewPayload | null>(null);
  const [mutationOutcome, setMutationOutcome] = useState<HarnessMutationOutcome | null>(null);
  const [releaseOutcome, setReleaseOutcome] = useState<HarnessReleaseOutcome | null>(null);

  const previewMutation = useMutation({
    mutationFn: (operation: ProjectHarnessOperation) =>
      client.previewProjectHarness({
        projectId,
        workspaceId: workspace.id,
        operation,
      }),
    onSuccess: (result) => {
      setPreview(result);
      setMutationOutcome(null);
    },
  });

  const mutation = useMutation({
    mutationFn: async (plan: ProjectHarnessPlan): Promise<HarnessMutationOutcome> => {
      const response =
        plan.operation === "bootstrap"
          ? await client.applyProjectHarness({
              projectId,
              workspaceId: workspace.id,
              plan,
            })
          : await client.updateProjectHarness({
              projectId,
              workspaceId: workspace.id,
              plan,
            });

      if (!response.ok) return { response, freshInspection: null, commit: null };

      try {
        const freshInspection = await client.inspectProjectHarness({
          projectId,
          workspaceId: workspace.id,
        });
        return {
          response,
          freshInspection,
          commit: {
            targetKey,
            receipt: response.result,
            readback: freshInspection.ok
              ? { status: "fresh", inspection: freshInspection.inspection }
              : { status: "rpc-error", error: freshInspection.error },
          },
        };
      } catch (error) {
        return {
          response,
          freshInspection: null,
          commit: {
            targetKey,
            receipt: response.result,
            readback: {
              status: "transport-error",
              message: errorDetail(error) ?? "Fresh inspection transport failed",
            },
          },
        };
      }
    },
    onSuccess: (outcome) => {
      const acceptedCommit = outcome.commit
        ? acceptProjectHarnessCommit(targetKey, outcome.commit)
        : null;
      if (outcome.commit && !acceptedCommit) return;
      setMutationOutcome(outcome);
      if (acceptedCommit) {
        setPreview(null);
      }
      if (acceptedCommit?.readback.status === "fresh" && outcome.freshInspection?.ok) {
        queryClient.setQueryData(queryKey, outcome.freshInspection);
      } else if (acceptedCommit) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  const releaseSelectors =
    query.data?.ok === true
      ? resolveProjectHarnessNotebookReleaseSelectors(query.data.inspection)
      : null;
  const releaseMutation = useMutation({
    mutationFn: async (
      selectors: ProjectHarnessNotebookReleaseSelectors,
    ): Promise<HarnessReleaseOutcome> => {
      const response = await client.releaseProjectHarnessNotebook({
        projectId,
        workspaceId: workspace.id,
        ...selectors,
      });
      if (!response.ok) return { response, freshInspection: null, commit: null };

      try {
        const freshInspection = await client.inspectProjectHarness({
          projectId,
          workspaceId: workspace.id,
        });
        return {
          response,
          freshInspection,
          commit: {
            targetKey,
            receipt: response.result,
            readback: freshInspection.ok
              ? { status: "fresh", inspection: freshInspection.inspection }
              : { status: "rpc-error", error: freshInspection.error },
          },
        };
      } catch (error) {
        return {
          response,
          freshInspection: null,
          commit: {
            targetKey,
            receipt: response.result,
            readback: {
              status: "transport-error",
              message: errorDetail(error) ?? "Fresh inspection transport failed",
            },
          },
        };
      }
    },
    onSuccess: (outcome) => {
      const acceptedCommit = outcome.commit
        ? acceptProjectHarnessCommit(targetKey, outcome.commit)
        : null;
      if (outcome.commit && !acceptedCommit) return;
      setReleaseOutcome(outcome);
      if (acceptedCommit?.readback.status === "fresh" && outcome.freshInspection?.ok) {
        queryClient.setQueryData(queryKey, outcome.freshInspection);
      } else if (acceptedCommit) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  const reload = useCallback(() => {
    setPreview(null);
    setMutationOutcome(null);
    setReleaseOutcome(null);
    previewMutation.reset();
    mutation.reset();
    releaseMutation.reset();
    void query.refetch();
  }, [mutation, previewMutation, query, releaseMutation]);

  const handlePreview = useCallback(
    (operation: ProjectHarnessOperation) => {
      setMutationOutcome(null);
      previewMutation.mutate(operation);
    },
    [previewMutation],
  );

  const handleMutation = useCallback(() => {
    if (!preview?.ok || !preview.readyToApply) return;
    mutation.mutate(preview.plan);
  }, [mutation, preview]);

  const handleRelease = useCallback(() => {
    if (!releaseSelectors) return;
    releaseMutation.mutate(releaseSelectors);
  }, [releaseMutation, releaseSelectors]);

  const handlePreviewBootstrap = useCallback(() => handlePreview("bootstrap"), [handlePreview]);
  const handlePreviewUpdate = useCallback(() => handlePreview("update"), [handlePreview]);

  return (
    <SettingsSection
      title={workspace.title || workspace.name || workspace.id}
      testID={`project-harness-workspace-${workspace.id}`}
      flush={last}
    >
      <Text style={styles.workspaceId} numberOfLines={1}>
        {workspace.id}
      </Text>

      <ProjectHarnessInspectionState
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        data={query.data}
        onReload={reload}
      />
      <ProjectHarnessWorkspaceActions
        workspaceId={workspace.id}
        previewPending={previewMutation.isPending}
        mutationPending={mutation.isPending}
        releasePending={releaseMutation.isPending}
        releaseAvailable={Boolean(releaseSelectors)}
        releaseConsumed={isProjectHarnessPlanConsumed(releaseOutcome?.commit ?? null)}
        fetching={query.isFetching}
        onPreviewBootstrap={handlePreviewBootstrap}
        onPreviewUpdate={handlePreviewUpdate}
        onRelease={handleRelease}
        onReload={reload}
      />
      <ProjectHarnessWorkspaceFeedback
        inspectionAvailable={query.data?.ok === true}
        releaseAvailable={Boolean(releaseSelectors)}
        preview={preview}
        previewError={previewMutation.isError ? previewMutation.error : null}
        mutationPending={mutation.isPending}
        onMutate={handleMutation}
        releaseError={releaseMutation.isError ? releaseMutation.error : null}
        releaseOutcome={releaseOutcome}
        mutationError={mutation.isError ? mutation.error : null}
        mutationOutcome={mutationOutcome}
        onReload={reload}
      />
    </SettingsSection>
  );
}

function ProjectHarnessInspectionState({
  isLoading,
  isError,
  error,
  data,
  onReload,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: ProjectHarnessInspectPayload | undefined;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner color={styles.spinnerColor.color} />
      </View>
    );
  }
  if (isError || !data) {
    return (
      <HarnessFailure
        testID="project-harness-inspect-failed"
        title={t("settings.project.projectHarness.inspectFailedTitle")}
        detail={errorDetail(error)}
        fallback={t("settings.project.projectHarness.inspectFailedDescription")}
        onReload={onReload}
      />
    );
  }
  if (!data.ok) {
    return (
      <HarnessRpcFailure
        testID="project-harness-inspect-error"
        error={data.error}
        onReload={onReload}
      />
    );
  }
  return <ProjectHarnessInspectionView inspection={data.inspection} />;
}

function ProjectHarnessWorkspaceActions({
  workspaceId,
  previewPending,
  mutationPending,
  releasePending,
  releaseAvailable,
  releaseConsumed,
  fetching,
  onPreviewBootstrap,
  onPreviewUpdate,
  onRelease,
  onReload,
}: {
  workspaceId: string;
  previewPending: boolean;
  mutationPending: boolean;
  releasePending: boolean;
  releaseAvailable: boolean;
  releaseConsumed: boolean;
  fetching: boolean;
  onPreviewBootstrap: () => void;
  onPreviewUpdate: () => void;
  onRelease: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const mutationPendingOrPreviewing = previewPending || mutationPending;
  return (
    <View style={styles.actions}>
      <Button
        testID={`project-harness-preview-bootstrap-${workspaceId}`}
        onPress={onPreviewBootstrap}
        disabled={mutationPendingOrPreviewing}
        variant="outline"
        size="sm"
      >
        {previewPending
          ? t("settings.project.projectHarness.previewing")
          : t("settings.project.projectHarness.previewBootstrap")}
      </Button>
      <Button
        testID={`project-harness-preview-update-${workspaceId}`}
        onPress={onPreviewUpdate}
        disabled={mutationPendingOrPreviewing}
        variant="outline"
        size="sm"
      >
        {t("settings.project.projectHarness.previewUpdate")}
      </Button>
      <Button
        testID={`project-harness-release-${workspaceId}`}
        onPress={onRelease}
        disabled={
          !releaseAvailable || releaseConsumed || releasePending || mutationPendingOrPreviewing
        }
        variant="outline"
        size="sm"
      >
        {releasePending
          ? t("settings.project.projectHarness.releaseWriterPending")
          : t("settings.project.projectHarness.releaseWriter")}
      </Button>
      <Button
        testID={`project-harness-reload-${workspaceId}`}
        onPress={onReload}
        disabled={fetching || mutationPendingOrPreviewing}
        variant="ghost"
        size="sm"
      >
        {t("settings.project.actions.reload")}
      </Button>
    </View>
  );
}

function ProjectHarnessWorkspaceFeedback({
  inspectionAvailable,
  releaseAvailable,
  preview,
  previewError,
  mutationPending,
  onMutate,
  releaseError,
  releaseOutcome,
  mutationError,
  mutationOutcome,
  onReload,
}: {
  inspectionAvailable: boolean;
  releaseAvailable: boolean;
  preview: ProjectHarnessPreviewPayload | null;
  previewError: unknown;
  mutationPending: boolean;
  onMutate: () => void;
  releaseError: unknown;
  releaseOutcome: HarnessReleaseOutcome | null;
  mutationError: unknown;
  mutationOutcome: HarnessMutationOutcome | null;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {previewError ? (
        <HarnessFailure
          testID="project-harness-preview-failed"
          title={t("settings.project.projectHarness.previewFailedTitle")}
          detail={errorDetail(previewError)}
          fallback={t("settings.project.projectHarness.previewFailedDescription")}
          onReload={onReload}
        />
      ) : null}
      {preview && !preview.ok ? (
        <HarnessRpcFailure
          testID="project-harness-preview-error"
          error={preview.error}
          onReload={onReload}
        />
      ) : null}
      {preview?.ok ? (
        <ProjectHarnessPreviewView
          preview={preview}
          pending={mutationPending}
          onMutate={onMutate}
        />
      ) : null}
      {inspectionAvailable && !releaseAvailable ? (
        <Alert
          testID="project-harness-release-unavailable"
          variant="info"
          title={t("settings.project.projectHarness.releaseWriterUnavailable")}
          description={t("settings.project.projectHarness.releaseWriterUnavailableDescription")}
        />
      ) : null}
      {releaseError ? (
        <HarnessFailure
          testID="project-harness-release-failed"
          title={t("settings.project.projectHarness.releaseFailedTitle")}
          detail={errorDetail(releaseError)}
          fallback={t("settings.project.projectHarness.releaseFailedDescription")}
          onReload={onReload}
        />
      ) : null}
      {releaseOutcome ? (
        <ProjectHarnessReleaseView outcome={releaseOutcome} onReload={onReload} />
      ) : null}
      {mutationError ? (
        <HarnessFailure
          testID="project-harness-mutation-failed"
          title={t("settings.project.projectHarness.mutationFailedTitle")}
          detail={errorDetail(mutationError)}
          fallback={t("settings.project.projectHarness.mutationFailedDescription")}
          onReload={onReload}
        />
      ) : null}
      {mutationOutcome ? (
        <ProjectHarnessMutationView outcome={mutationOutcome} onReload={onReload} />
      ) : null}
    </>
  );
}

function ProjectHarnessInspectionView({ inspection }: { inspection: ProjectHarnessInspection }) {
  const { t } = useTranslation();
  const summary = summarizeProjectHarnessInspection(inspection);
  return (
    <View style={styles.inspection} testID="project-harness-inspection">
      <HarnessStatus
        label={t("settings.project.projectHarness.relationship")}
        value={summary.relationship}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.package")}
        value={summary.provenancePackage}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.generation")}
        value={String(summary.provenanceGeneration)}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.artifact")}
        value={summary.provenanceArtifactDigest}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.metadata")}
        value={summary.metadataStatus}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.foreignOwnership")}
        value={summary.foreignOwnershipStatus}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.foreignLocalDelta")}
        value={String(summary.foreignLocalDeltaCount)}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.foreignUnresolved")}
        value={String(summary.foreignUnresolvedCount)}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.instructionCoverage")}
        value={`${summary.coverage} (${summary.instructionCoverage})`}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.instructionUnknown")}
        value={String(summary.instructionUnknownCount)}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.recovery")}
        value={
          summary.recoveryReason
            ? `${summary.recoveryStatus}: ${summary.recoveryReason}`
            : summary.recoveryStatus
        }
      />
    </View>
  );
}

function ProjectHarnessPreviewView({
  preview,
  pending,
  onMutate,
}: {
  preview: Extract<ProjectHarnessPreviewPayload, { ok: true }>;
  pending: boolean;
  onMutate: () => void;
}) {
  const { t } = useTranslation();
  let mutationLabel: string;
  if (pending) {
    mutationLabel = t("settings.project.projectHarness.applying");
  } else if (preview.plan.operation === "bootstrap") {
    mutationLabel = t("settings.project.projectHarness.applyBootstrap");
  } else {
    mutationLabel = t("settings.project.projectHarness.applyUpdate");
  }
  return (
    <View style={styles.preview} testID="project-harness-preview">
      <HarnessStatus
        label={t("settings.project.projectHarness.operation")}
        value={preview.plan.operation}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.planDigest")}
        value={preview.plan.planDigest}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.readyToApply")}
        value={String(preview.readyToApply)}
      />
      {preview.changes.length === 0 ? (
        <Text style={styles.muted}>{t("settings.project.projectHarness.noChanges")}</Text>
      ) : (
        preview.changes.map((change) => (
          <ProjectHarnessChangeView key={change.path} change={change} />
        ))
      )}
      <Button
        testID="project-harness-apply-plan"
        onPress={onMutate}
        disabled={!preview.readyToApply || pending}
        variant="default"
        size="sm"
      >
        {mutationLabel}
      </Button>
    </View>
  );
}

function ProjectHarnessChangeView({ change }: { change: ProjectHarnessChange }) {
  return (
    <View style={styles.change} testID={`project-harness-change-${change.path}`}>
      <Text style={styles.changeTitle}>{describeProjectHarnessChange(change)}</Text>
      {change.diff ? <Text style={styles.diff}>{change.diff}</Text> : null}
    </View>
  );
}

function ProjectHarnessReleaseView({
  outcome,
  onReload,
}: {
  outcome: HarnessReleaseOutcome;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  if (!outcome.response.ok) {
    return (
      <HarnessRpcFailure
        testID="project-harness-release-error"
        error={outcome.response.error}
        onReload={onReload}
      />
    );
  }

  const result = outcome.response.result;

  return (
    <View style={styles.mutation} testID="project-harness-release-result">
      <HarnessStatus label={t("settings.project.projectHarness.releaseResult")} value="ok" />
      <HarnessStatus
        label={t("settings.project.projectHarness.target")}
        value={`${result.projectId}/${result.workspaceId}`}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.releasedWriter")}
        value={result.releasedWriterId}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.nextStep")}
        value={result.nextStep}
      />
      <ProjectHarnessReadbackView
        state={outcome.commit?.readback ?? null}
        successLabel={t("settings.project.projectHarness.releaseFreshReadback")}
        rpcTestID="project-harness-release-readback-error"
        transportTestID="project-harness-release-readback-failed"
        transportTitle={t("settings.project.projectHarness.releaseReadbackFailedTitle")}
        transportFallback={t("settings.project.projectHarness.releaseReadbackFailedDescription")}
        onReload={onReload}
      />
    </View>
  );
}

function ProjectHarnessMutationView({
  outcome,
  onReload,
}: {
  outcome: HarnessMutationOutcome;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  if (!outcome.response.ok) {
    return (
      <HarnessRpcFailure
        testID="project-harness-mutation-error"
        error={outcome.response.error}
        onReload={onReload}
      />
    );
  }

  const result: ProjectHarnessMutationResult = outcome.response.result;
  return (
    <View style={styles.mutation} testID="project-harness-mutation-result">
      <HarnessStatus
        label={t("settings.project.projectHarness.target")}
        value={`${result.inspection.target.projectId}/${result.inspection.target.workspaceId}`}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.transactionId")}
        value={result.transactionId}
      />
      <HarnessStatus
        label={t("settings.project.projectHarness.changedPaths")}
        value={String(result.changedPaths.length)}
      />
      {result.changedPaths.map((path) => (
        <Text key={path} style={styles.path}>
          {path}
        </Text>
      ))}
      <HarnessStatus
        label={t("settings.project.projectHarness.recovery")}
        value={
          result.recovery.reason
            ? `${result.recovery.status}: ${result.recovery.reason}`
            : result.recovery.status
        }
      />
      <ProjectHarnessReadbackView
        state={outcome.commit?.readback ?? null}
        successLabel={t("settings.project.projectHarness.freshReadback")}
        rpcTestID="project-harness-fresh-readback-error"
        transportTestID="project-harness-fresh-readback-failed"
        transportTitle={t("settings.project.projectHarness.readbackFailedTitle")}
        transportFallback={t("settings.project.projectHarness.readbackFailedDescription")}
        onReload={onReload}
      />
    </View>
  );
}

function ProjectHarnessReadbackView({
  state,
  successLabel,
  rpcTestID,
  transportTestID,
  transportTitle,
  transportFallback,
  onReload,
}: {
  state: ProjectHarnessReadbackState | null;
  successLabel: string;
  rpcTestID: string;
  transportTestID: string;
  transportTitle: string;
  transportFallback: string;
  onReload: () => void;
}) {
  if (!state) return null;
  if (state.status === "fresh") {
    return <Text style={styles.freshReadback}>{successLabel}</Text>;
  }
  if (state.status === "rpc-error") {
    return <HarnessRpcFailure testID={rpcTestID} error={state.error} onReload={onReload} />;
  }
  return (
    <HarnessFailure
      testID={transportTestID}
      title={transportTitle}
      detail={state.message}
      fallback={transportFallback}
      onReload={onReload}
    />
  );
}

function HarnessStatus({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue} selectable>
        {value}
      </Text>
    </View>
  );
}

function HarnessRpcFailure({
  testID,
  error,
  onReload,
}: {
  testID: string;
  error: ProjectHarnessRpcError;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const description = [error.message, error.paths?.join(", "), error.recovery?.reason]
    .filter((value): value is string => Boolean(value))
    .join(" — ");
  return (
    <Alert
      testID={testID}
      variant="error"
      title={error.code}
      description={description || t("settings.project.projectHarness.rpcFailedDescription")}
    >
      <Button onPress={onReload} variant="outline" size="sm">
        {t("settings.project.actions.reload")}
      </Button>
    </Alert>
  );
}

function HarnessFailure({
  testID,
  title,
  detail,
  fallback,
  onReload,
}: {
  testID: string;
  title: string;
  detail: string | null;
  fallback: string;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Alert testID={testID} variant="error" title={title} description={detail ?? fallback}>
      <Button onPress={onReload} variant="outline" size="sm">
        {t("settings.project.actions.reload")}
      </Button>
    </Alert>
  );
}

function errorDetail(error: unknown): string | null {
  return error instanceof Error && error.message.length > 0 ? error.message : null;
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    minHeight: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  workspaceId: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[3],
  },
  inspection: {
    gap: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    minWidth: 132,
  },
  statusValue: {
    color: theme.colors.foreground,
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  preview: {
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
  },
  change: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
  },
  changeTitle: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  diff: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  muted: {
    color: theme.colors.foregroundMuted,
  },
  mutation: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  path: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  freshReadback: {
    color: theme.colors.success,
    marginTop: theme.spacing[2],
  },
}));
