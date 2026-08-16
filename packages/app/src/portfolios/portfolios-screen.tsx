import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";
import { router } from "expo-router";
import { Archive, BriefcaseBusiness, FolderKanban, Plus, Settings, X } from "lucide-react-native";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostProjects } from "@/projects/host-projects";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildHostPortfolioRoute,
  buildHostPortfoliosRoute,
  buildProjectSettingsRoute,
} from "@/utils/host-routes";
import { AddPortfolioProjectSheet } from "./add-portfolio-project-sheet";
import { CreatePortfolioSheet } from "./create-portfolio-sheet";
import { usePortfolioMutations, usePortfoliosQuery } from "./data";
import { buildAvailablePortfolioProjects, buildPortfolioProjectMembers } from "./model";

interface PortfoliosScreenProps {
  serverId: string;
  selectedPortfolioId: string | null;
}

const EMPTY_PORTFOLIOS: PortfolioRecord[] = [];

const ThemedBriefcase = withUnistyles(BriefcaseBusiness);
const ThemedFolder = withUnistyles(FolderKanban);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.md,
});
const loadingMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PortfoliosScreen({ serverId, selectedPortfolioId }: PortfoliosScreenProps) {
  const isCompact = useIsCompactFormFactor();
  const query = usePortfoliosQuery(serverId);
  const { create, addProject, removeProject, archive } = usePortfolioMutations(serverId);
  const projects = useHostProjects([serverId]);
  const portfolios = query.data ?? EMPTY_PORTFOLIOS;
  const selectedPortfolio =
    portfolios.find((portfolio) => portfolio.id === selectedPortfolioId) ?? null;
  const [isCreateVisible, setCreateVisible] = useState(false);
  const [isAddProjectVisible, setAddProjectVisible] = useState(false);

  const availableProjects = useMemo(
    () => buildAvailablePortfolioProjects({ portfolios, projects, serverId }),
    [portfolios, projects, serverId],
  );
  const openCreate = useCallback(() => setCreateVisible(true), []);
  const closeCreate = useCallback(() => setCreateVisible(false), []);
  const openAddProject = useCallback(() => setAddProjectVisible(true), []);
  const closeAddProject = useCallback(() => setAddProjectVisible(false), []);
  const handleCreated = useCallback(
    (portfolio: PortfolioRecord) => {
      setCreateVisible(false);
      router.replace(buildHostPortfolioRoute(serverId, portfolio.id));
    },
    [serverId],
  );
  const createPortfolio = useCallback((name: string) => create(name), [create]);
  const addPortfolioProject = useCallback(
    async (projectId: string) => {
      if (!selectedPortfolioId) throw new Error("Portfolio unavailable");
      await addProject({ portfolioId: selectedPortfolioId, projectId });
    },
    [addProject, selectedPortfolioId],
  );
  const handleRetry = useCallback(() => void query.refetch(), [query]);
  const handleBack = useCallback(
    () => router.replace(buildHostPortfoliosRoute(serverId)),
    [serverId],
  );

  const newPortfolioButton = useMemo(
    () => (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={Plus}
        onPress={openCreate}
        disabled={!query.client || !query.isConnected || !query.supportsPortfolios}
        testID="portfolios-create"
      >
        New portfolio
      </Button>
    ),
    [openCreate, query.client, query.isConnected, query.supportsPortfolios],
  );

  let content: ReactNode;
  if (!query.supportsPortfolios) {
    content = (
      <PortfolioUnavailable
        title="Portfolios require a newer host"
        description="Update this Paseo host to manage multiple Projects as a Portfolio."
      />
    );
  } else if (!query.isConnected) {
    content = (
      <PortfolioUnavailable
        title="Host offline"
        description="Reconnect the Host to manage Portfolios."
      />
    );
  } else if (query.isPending) {
    content = <PortfolioLoading />;
  } else if (query.isError) {
    content = (
      <PortfolioUnavailable
        title="Unable to load portfolios"
        description={toErrorMessage(query.error)}
        onRetry={handleRetry}
      />
    );
  } else if (isCompact) {
    content = selectedPortfolioId ? (
      <PortfolioDetail
        serverId={serverId}
        portfolio={selectedPortfolio}
        requestedPortfolioId={selectedPortfolioId}
        projects={projects}
        availableProjectCount={availableProjects.length}
        onAddProject={openAddProject}
        onRemoveProject={removeProject}
        onArchive={archive}
        onArchived={handleBack}
      />
    ) : (
      <PortfolioList serverId={serverId} portfolios={portfolios} selectedPortfolioId={null} />
    );
  } else {
    content = (
      <View style={styles.desktopBody}>
        <View style={styles.desktopListPane}>
          <PortfolioList
            serverId={serverId}
            portfolios={portfolios}
            selectedPortfolioId={selectedPortfolioId}
          />
        </View>
        <View style={styles.desktopDetailPane}>
          {selectedPortfolioId ? (
            <PortfolioDetail
              serverId={serverId}
              portfolio={selectedPortfolio}
              requestedPortfolioId={selectedPortfolioId}
              projects={projects}
              availableProjectCount={availableProjects.length}
              onAddProject={openAddProject}
              onRemoveProject={removeProject}
              onArchive={archive}
              onArchived={handleBack}
            />
          ) : (
            <PortfolioEmpty
              text={portfolios.length === 0 ? "No portfolios yet" : "Select a portfolio"}
            />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="portfolios-screen">
      {isCompact && selectedPortfolioId ? (
        <BackHeader title={selectedPortfolio?.name ?? "Portfolio"} onBack={handleBack} />
      ) : (
        <MenuHeader title="Portfolios" rightContent={newPortfolioButton} />
      )}
      {content}
      <CreatePortfolioSheet
        visible={isCreateVisible}
        onClose={closeCreate}
        onCreate={createPortfolio}
        onCreated={handleCreated}
      />
      <AddPortfolioProjectSheet
        serverId={serverId}
        projects={availableProjects}
        visible={isAddProjectVisible}
        onClose={closeAddProject}
        onAdd={addPortfolioProject}
      />
    </View>
  );
}

function PortfolioUnavailable({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.unavailable}>
      <Alert title={title} description={description} variant="warning">
        {onRetry ? (
          <Button variant="outline" size="sm" onPress={onRetry}>
            Try again
          </Button>
        ) : null}
      </Alert>
    </View>
  );
}

function PortfolioLoading() {
  return (
    <View style={styles.centered}>
      <ThemedLoadingSpinner size="large" uniProps={loadingMapping} />
    </View>
  );
}

function PortfolioEmpty({ text }: { text: string }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function PortfolioList({
  serverId,
  portfolios,
  selectedPortfolioId,
}: {
  serverId: string;
  portfolios: PortfolioRecord[];
  selectedPortfolioId: string | null;
}) {
  if (portfolios.length === 0) return <PortfolioEmpty text="No portfolios yet" />;

  return (
    <ScrollView contentContainerStyle={styles.portfolioList} testID="portfolios-list">
      {portfolios.map((portfolio) => (
        <PortfolioRow
          key={portfolio.id}
          serverId={serverId}
          portfolio={portfolio}
          selected={portfolio.id === selectedPortfolioId}
        />
      ))}
    </ScrollView>
  );
}

function PortfolioRow({
  serverId,
  portfolio,
  selected,
}: {
  serverId: string;
  portfolio: PortfolioRecord;
  selected: boolean;
}) {
  const handlePress = useCallback(
    () => router.push(buildHostPortfolioRoute(serverId, portfolio.id)),
    [portfolio.id, serverId],
  );
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.portfolioRow,
      selected && styles.portfolioRowSelected,
      (hovered || pressed) && styles.portfolioRowHovered,
    ],
    [selected],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`${portfolio.name}, ${formatProjectCount(portfolio.projectIds.length)}`}
      testID={`portfolio-row-${portfolio.id}`}
    >
      <ThemedBriefcase uniProps={mutedIconMapping} />
      <View style={styles.portfolioRowBody}>
        <Text style={styles.portfolioName} numberOfLines={1}>
          {portfolio.name}
        </Text>
        <Text style={styles.portfolioMeta}>{formatProjectCount(portfolio.projectIds.length)}</Text>
      </View>
    </Pressable>
  );
}

function PortfolioDetail({
  serverId,
  portfolio,
  requestedPortfolioId,
  projects,
  availableProjectCount,
  onAddProject,
  onRemoveProject,
  onArchive,
  onArchived,
}: {
  serverId: string;
  portfolio: PortfolioRecord | null;
  requestedPortfolioId: string;
  projects: HostProjectListItem[];
  availableProjectCount: number;
  onAddProject: () => void;
  onRemoveProject: (input: { portfolioId: string; projectId: string }) => Promise<PortfolioRecord>;
  onArchive: (portfolioId: string) => Promise<PortfolioRecord>;
  onArchived: () => void;
}) {
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [isArchiving, setArchiving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const members = useMemo(
    () => (portfolio ? buildPortfolioProjectMembers({ portfolio, projects, serverId }) : []),
    [portfolio, projects, serverId],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      if (!portfolio) return;
      setPendingProjectId(projectId);
      setError(null);
      try {
        await onRemoveProject({ portfolioId: portfolio.id, projectId });
      } catch (nextError) {
        setError(nextError);
      } finally {
        setPendingProjectId(null);
      }
    },
    [onRemoveProject, portfolio],
  );
  const archivePortfolio = useCallback(async () => {
    if (!portfolio) return;
    const confirmed = await confirmDialog({
      title: `Archive ${portfolio.name}?`,
      message: "Projects and Workspaces in this Portfolio will remain active.",
      confirmLabel: "Archive",
      destructive: true,
    });
    if (!confirmed) return;
    setArchiving(true);
    setError(null);
    try {
      await onArchive(portfolio.id);
      onArchived();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setArchiving(false);
    }
  }, [onArchive, onArchived, portfolio]);
  const handleArchivePress = useCallback(() => void archivePortfolio(), [archivePortfolio]);

  if (!portfolio) {
    return (
      <PortfolioUnavailable
        title="Portfolio not found"
        description={`No active Portfolio matches ${requestedPortfolioId}.`}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.detailContent} testID="portfolio-detail">
      <View style={styles.detailHeading}>
        <View style={styles.detailTitleBody}>
          <Text style={styles.detailTitle}>{portfolio.name}</Text>
          <Text style={styles.detailSubtitle}>
            {formatProjectCount(portfolio.projectIds.length)} on this Host
          </Text>
        </View>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Plus}
          onPress={onAddProject}
          disabled={availableProjectCount === 0 || isArchiving}
          testID="portfolio-add-project"
        >
          Add project
        </Button>
      </View>

      {error ? (
        <Alert
          title="Portfolio update failed"
          description={toErrorMessage(error)}
          variant="error"
          testID="portfolio-update-error"
        />
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Projects</Text>
        {members.length === 0 ? (
          <View style={styles.emptyMembers}>
            <Text style={styles.emptyText}>No Projects in this Portfolio.</Text>
            <Text style={styles.emptyHint}>Add an existing Project from this Host.</Text>
          </View>
        ) : (
          <View style={styles.memberList}>
            {members.map((member) => (
              <PortfolioMemberRow
                key={member.projectId}
                serverId={serverId}
                projectId={member.projectId}
                name={member.name}
                available={Boolean(member.project)}
                loading={pendingProjectId === member.projectId}
                disabled={Boolean(pendingProjectId) || isArchiving}
                onRemove={removeProject}
              />
            ))}
          </View>
        )}
      </View>

      <View style={styles.archiveSection}>
        <View style={styles.archiveCopy}>
          <Text style={styles.sectionTitle}>Archive portfolio</Text>
          <Text style={styles.archiveDescription}>
            Removes this Portfolio from the active list. Its Projects and Workspaces stay active.
          </Text>
        </View>
        <Button
          variant="destructive"
          size="sm"
          leftIcon={Archive}
          onPress={handleArchivePress}
          loading={isArchiving}
          disabled={Boolean(pendingProjectId)}
          testID="portfolio-archive"
        >
          Archive
        </Button>
      </View>
    </ScrollView>
  );
}

function PortfolioMemberRow({
  serverId,
  projectId,
  name,
  available,
  loading,
  disabled,
  onRemove,
}: {
  serverId: string;
  projectId: string;
  name: string;
  available: boolean;
  loading: boolean;
  disabled: boolean;
  onRemove: (projectId: string) => Promise<void>;
}) {
  const handleSettings = useCallback(
    () => router.push(buildProjectSettingsRoute(serverId, projectId)),
    [projectId, serverId],
  );
  const handleRemove = useCallback(() => void onRemove(projectId), [onRemove, projectId]);

  return (
    <View style={styles.memberRow}>
      <ThemedFolder uniProps={mutedIconMapping} />
      <View style={styles.memberBody}>
        <Text style={styles.memberName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.memberId} numberOfLines={1}>
          {available ? projectId : "Project is no longer available"}
        </Text>
      </View>
      {available ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={Settings}
          onPress={handleSettings}
          accessibilityLabel={`Open settings for ${name}`}
        >
          Settings
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="xs"
        leftIcon={X}
        onPress={handleRemove}
        loading={loading}
        disabled={disabled}
        accessibilityLabel={`Remove ${name} from Portfolio`}
        testID={`portfolio-remove-project-${projectId}`}
      >
        Remove
      </Button>
    </View>
  );
}

function formatProjectCount(count: number): string {
  return `${count} ${count === 1 ? "Project" : "Projects"}`;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  desktopBody: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  desktopListPane: {
    width: 320,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  desktopDetailPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  unavailable: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    padding: theme.spacing[6],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  portfolioList: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  portfolioRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  portfolioRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  portfolioRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  portfolioRowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  portfolioName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  portfolioMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  detailContent: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[6],
  },
  detailHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
  },
  detailTitleBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  detailTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  detailSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  section: {
    gap: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  memberList: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    overflow: "hidden",
  },
  memberRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  memberBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  memberName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  memberId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyMembers: {
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[8],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
  },
  emptyHint: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  archiveSection: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
  },
  archiveCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  archiveDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
