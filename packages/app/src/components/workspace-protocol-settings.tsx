import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  WorkspaceProtocolRevision,
  WorkspaceProtocolRpcError,
  WorkspaceProtocolSnapshot,
} from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { SettingsGroup } from "@/components/settings/headings/settings-group";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";

type InspectResult = Awaited<ReturnType<DaemonClient["inspectWorkspaceProtocol"]>>;

export interface WorkspaceProtocolSettingsProps {
  client: DaemonClient;
  serverId: string;
  repoRoot: string;
  supported: boolean;
}

export function WorkspaceProtocolSettings({
  client,
  serverId,
  repoRoot,
  supported,
}: WorkspaceProtocolSettingsProps) {
  const { t } = useTranslation();
  const queryKey = ["workspace-protocol", serverId, repoRoot] as const;
  const query = useFetchQuery({
    queryKey,
    queryFn: () => client.inspectWorkspaceProtocol(repoRoot),
    retry: false,
    enabled: supported,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const handleReload = useCallback(() => void query.refetch(), [query]);

  if (!supported) {
    return (
      <SettingsGroup
        title={t("settings.project.workspaceProtocol.title")}
        info={t("settings.project.workspaceProtocol.info")}
        testID="workspace-protocol-group"
      >
        <Alert
          testID="workspace-protocol-unsupported"
          variant="info"
          title={t("settings.project.workspaceProtocol.unsupportedTitle")}
          description={t("settings.project.workspaceProtocol.unsupportedDescription")}
        />
      </SettingsGroup>
    );
  }

  if (query.isLoading) {
    return (
      <SettingsGroup
        title={t("settings.project.workspaceProtocol.title")}
        info={t("settings.project.workspaceProtocol.info")}
        testID="workspace-protocol-group"
      >
        <View style={styles.loading}>
          <LoadingSpinner color={styles.spinnerColor.color} />
        </View>
      </SettingsGroup>
    );
  }

  if (query.isError || !query.data) {
    return <WorkspaceProtocolLoadFailure error={query.error} onReload={handleReload} />;
  }

  if (!query.data.ok) {
    return <WorkspaceProtocolLoadFailure error={query.data.error} onReload={handleReload} />;
  }

  const snapshot = query.data.snapshot;
  if (snapshot.status === "unreadable") {
    return (
      <SettingsGroup
        title={t("settings.project.workspaceProtocol.title")}
        info={t("settings.project.workspaceProtocol.info")}
        testID="workspace-protocol-group"
      >
        <Alert
          testID="workspace-protocol-unreadable"
          variant="error"
          title={t("settings.project.workspaceProtocol.unreadableTitle")}
          description={t("settings.project.workspaceProtocol.unreadableDescription")}
        >
          <Button onPress={handleReload} variant="outline" size="sm">
            {t("settings.project.actions.reload")}
          </Button>
        </Alert>
      </SettingsGroup>
    );
  }

  return (
    <WorkspaceProtocolEditor
      key={snapshotKey(snapshot)}
      client={client}
      queryKey={queryKey}
      snapshot={snapshot}
    />
  );
}

function WorkspaceProtocolEditor({
  client,
  queryKey,
  snapshot,
}: {
  client: DaemonClient;
  queryKey: readonly [string, string, string];
  snapshot: Exclude<WorkspaceProtocolSnapshot, { status: "unreadable" }>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const initialContent =
    snapshot.status === "missing" ? snapshot.suggestedContent : snapshot.content;
  const [content, setContent] = useState(initialContent);
  const [writeError, setWriteError] = useState<WorkspaceProtocolRpcError | null>(null);
  const revision: WorkspaceProtocolRevision | null =
    snapshot.status === "missing" ? null : snapshot.revision;
  const changed = content !== initialContent;

  const mutation = useMutation({
    mutationFn: () =>
      client.writeWorkspaceProtocol({
        repoRoot: snapshot.repoRoot,
        content,
        expectedRevision: revision,
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setWriteError(result.error);
        return;
      }
      const next: InspectResult = {
        requestId: "local-cache",
        ok: true,
        snapshot: result.snapshot,
      };
      queryClient.setQueryData(queryKey, next);
      setWriteError(null);
      toast.show(t("settings.project.workspaceProtocol.saved"), { variant: "success" });
    },
  });

  const reload = useCallback(() => {
    setWriteError(null);
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const isStale = writeError?.code === "stale_workspace_protocol";
  const invalidIssues = resolveInvalidIssues(snapshot, writeError);
  const actionLabel = resolveActionLabel(snapshot.status, mutation.isPending, t);
  const handleSave = useCallback(() => mutation.mutate(), [mutation]);

  return (
    <SettingsGroup
      title={t("settings.project.workspaceProtocol.title")}
      info={t("settings.project.workspaceProtocol.info")}
      testID="workspace-protocol-group"
    >
      <SettingsSection
        title={t(`settings.project.workspaceProtocol.status.${snapshot.status}`)}
        testID="workspace-protocol-editor-section"
        flush
      >
        {snapshot.status === "missing" ? (
          <Alert
            testID="workspace-protocol-missing"
            variant="info"
            title={t("settings.project.workspaceProtocol.missingTitle")}
            description={t("settings.project.workspaceProtocol.missingDescription")}
          />
        ) : null}
        {invalidIssues.length > 0 ? (
          <Alert
            testID="workspace-protocol-invalid"
            variant="error"
            title={t("settings.project.workspaceProtocol.invalidTitle")}
            description={`${t("settings.project.workspaceProtocol.invalidDescription")} ${invalidIssues.join(", ")}`}
          />
        ) : null}
        {isStale ? (
          <Alert
            testID="workspace-protocol-stale"
            variant="error"
            title={t("settings.project.workspaceProtocol.staleTitle")}
            description={t("settings.project.workspaceProtocol.staleDescription")}
          >
            <Button onPress={reload} variant="outline" size="sm">
              {t("settings.project.actions.reload")}
            </Button>
          </Alert>
        ) : null}
        {writeError?.code === "write_failed" ? (
          <Alert
            testID="workspace-protocol-write-failed"
            variant="error"
            title={t("settings.project.workspaceProtocol.writeFailedTitle")}
            description={t("settings.project.workspaceProtocol.writeFailedDescription")}
          />
        ) : null}
        <SettingsTextAreaCard
          testID="workspace-protocol-input"
          accessibilityLabel={t("settings.project.workspaceProtocol.editorAccessibility")}
          value={content}
          onChangeText={setContent}
          style={styles.editor}
        />
        <View style={styles.footer}>
          <Text style={styles.path} numberOfLines={1}>
            {snapshot.path}
          </Text>
          <Button
            testID="workspace-protocol-save"
            onPress={handleSave}
            disabled={mutation.isPending || isStale || (snapshot.status !== "missing" && !changed)}
            variant="default"
            size="sm"
          >
            {actionLabel}
          </Button>
        </View>
      </SettingsSection>
    </SettingsGroup>
  );
}

function WorkspaceProtocolLoadFailure({
  error,
  onReload,
}: {
  error: unknown;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const detail = error instanceof Error ? error.message : null;
  return (
    <SettingsGroup
      title={t("settings.project.workspaceProtocol.title")}
      info={t("settings.project.workspaceProtocol.info")}
      testID="workspace-protocol-group"
    >
      <Alert
        testID="workspace-protocol-load-failed"
        variant="error"
        title={t("settings.project.workspaceProtocol.loadFailedTitle")}
        description={detail ?? t("settings.project.workspaceProtocol.loadFailedDescription")}
      >
        <Button onPress={onReload} variant="outline" size="sm">
          {t("settings.project.actions.reload")}
        </Button>
      </Alert>
    </SettingsGroup>
  );
}

function snapshotKey(
  snapshot: Exclude<WorkspaceProtocolSnapshot, { status: "unreadable" }>,
): string {
  if (snapshot.status === "missing") return `${snapshot.repoRoot}:missing`;
  return `${snapshot.repoRoot}:${snapshot.revision.sha256}`;
}

function resolveInvalidIssues(
  snapshot: Exclude<WorkspaceProtocolSnapshot, { status: "unreadable" }>,
  error: WorkspaceProtocolRpcError | null,
) {
  if (error?.code === "invalid_content") return error.issues;
  if (snapshot.status === "invalid") return snapshot.issues;
  return [];
}

function resolveActionLabel(
  status: Exclude<WorkspaceProtocolSnapshot["status"], "unreadable">,
  pending: boolean,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (status === "missing") return t("settings.project.workspaceProtocol.bootstrap");
  if (pending) return t("settings.project.actions.saving");
  return t("settings.project.actions.save");
}

const styles = StyleSheet.create((theme) => ({
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  loading: {
    minHeight: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  editor: {
    minHeight: 280,
    fontFamily: theme.fontFamily.mono,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
  },
  path: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    flex: 1,
  },
}));
