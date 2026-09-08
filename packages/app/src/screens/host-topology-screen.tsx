import { useCallback, useMemo, useState } from "react";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react-native";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import {
  buildHostTopology,
  formatTopologyAssignment,
  type TopologyEdge,
  type TopologyNode,
} from "@/panels/topology-model";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import {
  filterTopologyNodes,
  TOPOLOGY_STATUS_FILTERS,
  type TopologyProjectFilter,
  type TopologyStatusFilter,
} from "./host-topology-filters";

const ROLE_ORDER = ["supervisor", "lead", "peer", "unbound"] as const;
const UNASSIGNED_PROJECT_ID = "unassigned";

function resolveStatusFilterLabel(
  status: TopologyStatusFilter,
  t: (key: string) => string,
): string {
  if (status === "all") return t("hostTopology.statusFilterAll");
  return t(`agentList.status.${status}`);
}

function FilterChip({
  id,
  label,
  isActive,
  onSelect,
  testID,
  accessibilityLabel,
}: {
  id: string;
  label: string;
  isActive: boolean;
  onSelect: (id: string) => void;
  testID: string;
  accessibilityLabel: string;
}) {
  const handlePress = useCallback(() => onSelect(id), [onSelect, id]);
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.statusFilterChip, isActive && styles.statusFilterChipActive]}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={[styles.statusFilterChipText, isActive && styles.statusFilterChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

interface ProjectGroup {
  label: string;
  nodes: TopologyNode[];
}

function agentCardStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.agentCard, (hovered || pressed) && styles.agentCardActive];
}

function TopologyAgentCard({
  serverId,
  node,
  edge,
  parent,
}: {
  serverId: string;
  node: TopologyNode;
  edge: TopologyEdge | undefined;
  parent: TopologyNode | undefined;
}) {
  const { t } = useTranslation();
  const assignmentLabel = formatTopologyAssignment(node);
  const statusLabel = t(`agentList.status.${node.status}`);
  const handlePress = useCallback(() => {
    router.push(buildHostAgentDetailRoute(serverId, node.id, node.workspaceId ?? undefined));
  }, [node.id, node.workspaceId, serverId]);
  return (
    <Pressable
      onPress={handlePress}
      style={agentCardStyle}
      testID={`host-topology-agent-${node.id}`}
      accessibilityRole="button"
      accessibilityLabel={t("hostTopology.agentAccessibilityLabel", {
        title: node.title,
        status: statusLabel,
      })}
    >
      <View style={styles.agentHeading}>
        <Text style={styles.agentTitle}>{node.title}</Text>
        <View style={styles.statusIndicator}>
          <View style={[styles.statusDot, styles[`status_${node.status}`]]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>
      </View>
      <Text style={styles.agentMeta} numberOfLines={1}>
        {node.provider}/{node.model ?? "default"} · mode {node.modeId ?? "default"}
      </Text>
      {node.launchProfile ? (
        <Text style={styles.agentMeta} numberOfLines={1}>
          Profile {node.launchProfile.name} ({node.launchProfile.id})
        </Text>
      ) : null}
      {assignmentLabel ? (
        <Text style={styles.agentMeta} numberOfLines={1}>
          {assignmentLabel}
        </Text>
      ) : null}
      {parent && edge ? (
        <Text style={styles.relation}>
          {edge.kind === "supervision" ? "supervised" : "delegated"} by {parent.title}
        </Text>
      ) : null}
    </Pressable>
  );
}

function ProjectTopologySection({
  serverId,
  group,
  parentByChild,
  nodeById,
}: {
  serverId: string;
  group: ProjectGroup;
  parentByChild: ReadonlyMap<string, TopologyEdge>;
  nodeById: ReadonlyMap<string, TopologyNode>;
}) {
  return (
    <View style={styles.projectSection}>
      <Text style={styles.projectTitle}>{group.label}</Text>
      <View style={styles.roleGrid}>
        {ROLE_ORDER.map((role) => {
          const nodes = group.nodes.filter((node) => node.role === role);
          if (nodes.length === 0) return null;
          return (
            <View key={role} style={styles.roleColumn}>
              <Text style={styles.roleTitle}>
                {role.toUpperCase()} · {nodes.length}
              </Text>
              {nodes.map((node) => {
                const edge = parentByChild.get(node.id);
                return (
                  <TopologyAgentCard
                    key={node.id}
                    serverId={serverId}
                    node={node}
                    edge={edge}
                    parent={edge ? nodeById.get(edge.source) : undefined}
                  />
                );
              })}
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function HostTopologyScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const session = useSessionStore((state) => state.sessions[serverId]);
  const topology = useMemo(() => buildHostTopology(session?.agents), [session?.agents]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TopologyStatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState<TopologyProjectFilter>("all");
  const resolveProjectId = useCallback(
    (node: TopologyNode): string => {
      const workspace = node.workspaceId ? session?.workspaces?.get(node.workspaceId) : undefined;
      return workspace?.projectId ?? UNASSIGNED_PROJECT_ID;
    },
    [session?.workspaces],
  );
  const projectOptions = useMemo(() => {
    const workspaces = session?.workspaces;
    const labelById = new Map<string, string>();
    for (const node of topology.nodes) {
      const workspace = node.workspaceId ? workspaces?.get(node.workspaceId) : undefined;
      const projectId = workspace?.projectId ?? UNASSIGNED_PROJECT_ID;
      if (!labelById.has(projectId)) {
        labelById.set(projectId, workspace?.projectDisplayName ?? "Unassigned agents");
      }
    }
    return [...labelById.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [session?.workspaces, topology.nodes]);
  const filteredNodes = useMemo(
    () =>
      filterTopologyNodes(
        topology.nodes,
        { query: searchQuery, status: statusFilter, projectId: projectFilter },
        resolveProjectId,
      ),
    [topology.nodes, searchQuery, statusFilter, projectFilter, resolveProjectId],
  );
  const projectGroups = useMemo(() => {
    const workspaces = session?.workspaces;
    const grouped = new Map<string, ProjectGroup>();
    for (const node of filteredNodes) {
      const workspace = node.workspaceId ? workspaces?.get(node.workspaceId) : undefined;
      const key = resolveProjectId(node);
      const group = grouped.get(key) ?? {
        label: workspace?.projectDisplayName ?? "Unassigned agents",
        nodes: [],
      };
      group.nodes.push(node);
      grouped.set(key, group);
    }
    return [...grouped.entries()].sort((left, right) =>
      left[1].label.localeCompare(right[1].label),
    );
  }, [session?.workspaces, filteredNodes, resolveProjectId]);
  const parentByChild = useMemo(
    () => new Map(topology.edges.map((edge) => [edge.target, edge])),
    [topology.edges],
  );
  const nodeById = useMemo(
    () => new Map(topology.nodes.map((node) => [node.id, node])),
    [topology.nodes],
  );
  const hasAnyAgents = topology.nodes.length > 0;
  const isFiltering =
    searchQuery.trim().length > 0 || statusFilter !== "all" || projectFilter !== "all";
  const handleSelectStatus = useCallback(
    (id: string) => setStatusFilter(id as TopologyStatusFilter),
    [],
  );
  const handleSelectProject = useCallback((id: string) => setProjectFilter(id), []);

  const filterBar = hasAnyAgents ? (
    <View style={styles.filterBar} testID="host-topology-filter-bar">
      <SearchField
        value={searchQuery}
        onChangeText={setSearchQuery}
        placeholder={t("hostTopology.searchPlaceholder")}
        clearAccessibilityLabel={t("hostTopology.searchClearAccessibilityLabel")}
        testID="host-topology-search"
        clearTestID="host-topology-search-clear"
      />
      <View style={styles.statusFilterRow}>
        {TOPOLOGY_STATUS_FILTERS.map((status) => {
          const label = resolveStatusFilterLabel(status, t);
          return (
            <FilterChip
              key={status}
              id={status}
              label={label}
              isActive={statusFilter === status}
              onSelect={handleSelectStatus}
              testID={`host-topology-status-filter-${status}`}
              accessibilityLabel={t("hostTopology.statusFilterAccessibilityLabel", {
                status: label,
              })}
            />
          );
        })}
      </View>
      {projectOptions.length > 1 ? (
        <View style={styles.statusFilterRow}>
          <FilterChip
            id="all"
            label={t("hostTopology.projectFilterAll")}
            isActive={projectFilter === "all"}
            onSelect={handleSelectProject}
            testID="host-topology-project-filter-all"
            accessibilityLabel={t("hostTopology.projectFilterAccessibilityLabel", {
              project: t("hostTopology.projectFilterAll"),
            })}
          />
          {projectOptions.map(([projectId, label]) => (
            <FilterChip
              key={projectId}
              id={projectId}
              label={label}
              isActive={projectFilter === projectId}
              onSelect={handleSelectProject}
              testID={`host-topology-project-filter-${projectId}`}
              accessibilityLabel={t("hostTopology.projectFilterAccessibilityLabel", {
                project: label,
              })}
            />
          ))}
        </View>
      ) : null}
    </View>
  ) : null;

  let content;
  if (!session?.hasHydratedAgents) {
    content = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.muted.color} />
      </View>
    );
  } else if (!hasAnyAgents) {
    content = (
      <View style={styles.centered}>
        <Network size={28} color={styles.muted.color} />
        <Text style={styles.emptyTitle}>No agents in topology</Text>
        <Text style={styles.emptyText}>Create role-bound agents to populate project topology.</Text>
      </View>
    );
  } else if (isFiltering && projectGroups.length === 0) {
    content = (
      <View style={styles.screen}>
        {filterBar}
        <View style={styles.centered}>
          <Text style={styles.emptyText}>{t("hostTopology.noMatches")}</Text>
        </View>
      </View>
    );
  } else {
    content = (
      <ScrollView contentContainerStyle={styles.content}>
        {filterBar}
        <View style={styles.summary}>
          <Text style={styles.summaryTitle}>All projects</Text>
          <Text style={styles.summaryMeta}>
            {topology.nodes.length} agents · {topology.edges.length} exact relationship
            {topology.edges.length === 1 ? "" : "s"}
          </Text>
          {topology.counts.unbound > 0 ? (
            <Text style={styles.warning}>
              {topology.counts.unbound} unbound agent{topology.counts.unbound === 1 ? "" : "s"};
              provider subagents are not Paseo Peers.
            </Text>
          ) : null}
        </View>
        {projectGroups.map(([projectId, group]) => (
          <ProjectTopologySection
            key={projectId}
            serverId={serverId}
            group={group}
            parentByChild={parentByChild}
            nodeById={nodeById}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen} testID="host-topology-screen">
      <MenuHeader title="Project topology" />
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[6], gap: theme.spacing[6] },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[2] },
  muted: { color: theme.colors.foregroundMuted },
  emptyTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.lg },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  filterBar: { gap: theme.spacing[2] },
  statusFilterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  statusFilterChip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  statusFilterChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  statusFilterChipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusFilterChipTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  summary: { gap: theme.spacing[1] },
  summaryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
  },
  summaryMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  projectSection: { gap: theme.spacing[3] },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  roleGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    alignItems: "flex-start",
  },
  roleColumn: { width: 280, gap: theme.spacing[2] },
  roleTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    letterSpacing: 0.7,
  },
  agentCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  agentCardActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  agentHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  agentTitle: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  agentMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  relation: { color: theme.colors.accent, fontSize: theme.fontSize.xs },
  statusIndicator: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  statusText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  statusDot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  status_initializing: { backgroundColor: theme.colors.statusDotWarning },
  status_idle: { backgroundColor: theme.colors.statusDotSuccess },
  status_running: { backgroundColor: theme.colors.statusDotRunning },
  status_error: { backgroundColor: theme.colors.statusDotDanger },
  status_closed: { backgroundColor: theme.colors.foregroundExtraMuted },
}));
