import { useCallback, useMemo, useState } from "react";
import { FolderKanban } from "lucide-react-native";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

interface AddPortfolioProjectSheetProps {
  serverId: string;
  projects: readonly HostProjectListItem[];
  visible: boolean;
  onClose: () => void;
  onAdd: (projectId: string) => Promise<void>;
}

const ADD_PROJECT_HEADER = { title: "Add project" };
const ADD_PROJECT_SNAP_POINTS = ["60%", "85%"];
const ThemedFolderKanban = withUnistyles(FolderKanban);
const projectIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.md,
});

export function AddPortfolioProjectSheet({
  serverId,
  projects,
  visible,
  onClose,
  onAdd,
}: AddPortfolioProjectSheetProps) {
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const handleClose = useCallback(() => {
    if (pendingProjectId) return;
    setError(null);
    onClose();
  }, [onClose, pendingProjectId]);

  const addProject = useCallback(
    async (projectId: string) => {
      setPendingProjectId(projectId);
      setError(null);
      try {
        await onAdd(projectId);
        onClose();
      } catch (nextError) {
        setError(nextError);
      } finally {
        setPendingProjectId(null);
      }
    },
    [onAdd, onClose],
  );

  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onPress={handleClose}
          disabled={Boolean(pendingProjectId)}
        >
          Done
        </Button>
      </View>
    ),
    [handleClose, pendingProjectId],
  );

  return (
    <AdaptiveModalSheet
      header={ADD_PROJECT_HEADER}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      snapPoints={ADD_PROJECT_SNAP_POINTS}
      testID="add-portfolio-project-sheet"
    >
      {projects.length === 0 ? (
        <Text style={styles.emptyText}>
          Every available Project already belongs to a Portfolio.
        </Text>
      ) : (
        <ScrollView contentContainerStyle={styles.projectList}>
          {projects.map((project) => {
            const projectId = getHostProjectId(project, serverId);
            if (!projectId) return null;
            return (
              <ProjectChoice
                key={projectId}
                project={project}
                projectId={projectId}
                disabled={Boolean(pendingProjectId)}
                loading={pendingProjectId === projectId}
                onPress={addProject}
              />
            );
          })}
        </ScrollView>
      )}
      {error ? (
        <Text style={styles.error} testID="add-portfolio-project-error">
          {toErrorMessage(error)}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function ProjectChoice({
  project,
  projectId,
  disabled,
  loading,
  onPress,
}: {
  project: HostProjectListItem;
  projectId: string;
  disabled: boolean;
  loading: boolean;
  onPress: (projectId: string) => Promise<void>;
}) {
  const handlePress = useCallback(() => void onPress(projectId), [onPress, projectId]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.projectRow,
      (hovered || pressed) && styles.projectRowHovered,
      disabled && styles.disabled,
    ],
    [disabled],
  );

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`Add ${project.projectName}`}
      testID={`add-portfolio-project-${projectId}`}
    >
      <ThemedFolderKanban uniProps={projectIconMapping} />
      <View style={styles.projectBody}>
        <Text style={styles.projectName} numberOfLines={1}>
          {project.projectName}
        </Text>
        <Text style={styles.projectId} numberOfLines={1}>
          {projectId}
        </Text>
      </View>
      <Text style={styles.addLabel}>{loading ? "Adding..." : "Add"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  projectList: {
    gap: theme.spacing[2],
  },
  projectRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  projectRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  projectBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  projectName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  projectId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  addLabel: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[8],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
