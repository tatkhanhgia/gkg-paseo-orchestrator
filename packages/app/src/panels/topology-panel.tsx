import { Network } from "lucide-react-native";
import { useCallback } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { PanelRegistration } from "@/panels/panel-registry";
import {
  formatTopologyAssignment,
  TOPOLOGY_EDGE_LABELS,
  type TopologyEdge,
  type TopologyNode,
  type TopologyRole,
} from "@/panels/topology-model";
import { useTopologyPanelDescriptor, useTopologyPanelState } from "@/panels/use-topology-panel";
import type { Theme } from "@/styles/theme";

const ROLE_ORDER: TopologyRole[] = ["supervisor", "lead", "peer", "unbound"];
const ROLE_LABELS: Record<TopologyRole, string> = {
  supervisor: "Supervisors",
  lead: "Leads",
  peer: "Peers",
  unbound: "Unbound agents",
};
const ThemedNetwork = withUnistyles(Network);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function nodeStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.node, (hovered || pressed) && styles.nodeHovered];
}

function TopologyNodeRow({
  node,
  openAgent,
  issueById,
  parentTitle,
  relationship,
  workspaceLabel,
  isLineageSeed,
  viewLineage,
}: {
  node: TopologyNode;
  openAgent: (agentId: string) => void;
  issueById: ReadonlyMap<string, BeadsIssue>;
  parentTitle?: string;
  relationship?: TopologyEdge["kind"];
  workspaceLabel: string | null;
  isLineageSeed: boolean;
  viewLineage: (agentId: string) => void;
}) {
  const assignmentLabel = formatTopologyAssignment(node);
  const handleOpen = useCallback(() => openAgent(node.id), [node.id, openAgent]);
  const handleViewLineage = useCallback(() => viewLineage(node.id), [node.id, viewLineage]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${node.title}, ${node.role}, ${node.status}`}
      onPress={handleOpen}
      style={nodeStyle}
    >
      <View style={styles.nodeHeading}>
        <Text style={styles.roleLabel}>{node.role.toUpperCase()}</Text>
        <View style={styles.nodeHeadingActions}>
          {isLineageSeed ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View lineage from ${node.title}`}
              onPress={handleViewLineage}
              style={styles.lineageAction}
              testID={`topology-view-lineage-${node.id}`}
            >
              <Text style={styles.lineageActionText}>Lineage</Text>
            </Pressable>
          )}
          <View style={[styles.statusDot, styles[`status_${node.status}`]]} />
        </View>
      </View>
      <Text style={styles.nodeTitle} numberOfLines={1}>
        {node.title}
      </Text>
      <Text style={styles.nodeMeta} numberOfLines={1}>
        {node.status} · {node.provider}/{node.model ?? "default"} · mode {node.modeId ?? "default"}
      </Text>
      {node.launchProfile ? (
        <Text style={styles.nodeMeta} numberOfLines={1}>
          Profile {node.launchProfile.name} ({node.launchProfile.id})
        </Text>
      ) : null}
      {assignmentLabel ? (
        <Text style={styles.nodeMeta} numberOfLines={1}>
          {assignmentLabel}
        </Text>
      ) : null}
      {workspaceLabel ? (
        <Text style={styles.nodeWorkspace} numberOfLines={1}>
          {workspaceLabel}
        </Text>
      ) : null}
      {parentTitle && relationship ? (
        <Text style={styles.nodeRelation} numberOfLines={1}>
          {TOPOLOGY_EDGE_LABELS[relationship].byline} by {parentTitle}
        </Text>
      ) : null}
      {node.issueIds.length > 0 ? (
        <View style={styles.nodeIssues}>
          <Text style={styles.nodeIssuesLabel}>Assigned issues</Text>
          {node.issueIds.slice(0, 2).map((issueId) => {
            const issue = issueById.get(issueId);
            return (
              <Text key={issueId} style={styles.nodeIssue} numberOfLines={1}>
                {issue?.title ?? issueId}
              </Text>
            );
          })}
          {node.issueIds.length > 2 ? (
            <Text style={styles.nodeIssueMore}>+{node.issueIds.length - 2} more</Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function TopologyPanel() {
  const {
    topology,
    hydrated,
    openAgent,
    issueById,
    grantedIssueCount,
    issuesError,
    projectName,
    lineage,
    viewLineage,
    showProjectTopology,
  } = useTopologyPanelState();
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const parentByChild = new Map(topology.edges.map((edge) => [edge.target, edge]));
  if (!hydrated) {
    return (
      <View style={styles.centered} testID="workspace-topology-loading">
        <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
      </View>
    );
  }
  if (topology.nodes.length === 0) {
    return (
      <View style={styles.centered} testID="workspace-topology-empty">
        <ThemedNetwork size={24} uniProps={mutedColorMapping} />
        <Text style={styles.emptyTitle}>No agents in topology</Text>
        <Text style={styles.emptyText}>Create role-bound agents to populate this topology.</Text>
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="workspace-topology-panel"
    >
      <View style={styles.summaryRow}>
        <Text style={styles.summaryTitle}>
          {lineage ? `Lineage · ${lineage.seedTitle}` : `Project topology · ${projectName}`}
        </Text>
        <Text style={styles.summaryMeta}>
          {topology.nodes.length} agents · {topology.edges.length} relationship
          {topology.edges.length === 1 ? "" : "s"}
          {lineage
            ? ` · ${lineage.workspaceCount} workspace${lineage.workspaceCount === 1 ? "" : "s"}`
            : ""}
        </Text>
        <Text style={styles.summaryMeta}>
          {grantedIssueCount} assigned issue{grantedIssueCount === 1 ? "" : "s"}
        </Text>
        {lineage ? (
          <Pressable
            accessibilityRole="button"
            onPress={showProjectTopology}
            style={styles.lineageAction}
            testID="topology-show-project"
          >
            <Text style={styles.lineageActionText}>Back to project topology</Text>
          </Pressable>
        ) : null}
      </View>
      {topology.warnings.length > 0 ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>
            {topology.warnings.length} relationship
            {topology.warnings.length === 1 ? "" : "s"} need review. Ambiguous or missing bindings
            are not drawn as authority.
          </Text>
        </View>
      ) : null}
      {issuesError && grantedIssueCount > 0 ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>
            Issue details unavailable; exact assignment grants remain shown.
          </Text>
        </View>
      ) : null}
      {ROLE_ORDER.map((role) => {
        const nodes = topology.nodes.filter((node) => node.role === role);
        if (nodes.length === 0) return null;
        return (
          <View key={role} style={styles.section}>
            <Text style={styles.sectionLabel}>{ROLE_LABELS[role]}</Text>
            <View style={styles.nodeList}>
              {nodes.map((node) => {
                const relationship = parentByChild.get(node.id);
                const parent = relationship ? nodeById.get(relationship.source) : undefined;
                return (
                  <TopologyNodeRow
                    key={node.id}
                    node={node}
                    openAgent={openAgent}
                    issueById={issueById}
                    parentTitle={parent?.title}
                    relationship={relationship?.kind}
                    workspaceLabel={lineage?.workspaceLabelOf(node) ?? null}
                    isLineageSeed={node.id === lineage?.seedId}
                    viewLineage={viewLineage}
                  />
                );
              })}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

export const topologyPanelRegistration: PanelRegistration<"topology"> = {
  kind: "topology",
  supportedHosts: ["main"],
  resourceKey: () => "topology",
  component: TopologyPanel,
  useDescriptor: useTopologyPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[4] },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  emptyTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  summaryRow: { gap: theme.spacing[1] },
  summaryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  summaryMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  warning: {
    borderWidth: 1,
    borderColor: `${theme.colors.statusWarning}33`,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: `${theme.colors.statusWarning}1a`,
  },
  warningText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.xs,
  },
  section: { gap: theme.spacing[2] },
  sectionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  nodeList: { gap: theme.spacing[2] },
  node: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  nodeHovered: { backgroundColor: theme.colors.surface2 },
  nodeHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  roleLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.8,
  },
  nodeTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  nodeMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  nodeRelation: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
  },
  nodeWorkspace: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  nodeHeadingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  lineageAction: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
  },
  lineageActionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  nodeIssues: {
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  nodeIssuesLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  nodeIssue: { color: theme.colors.foreground, fontSize: theme.fontSize.xs },
  nodeIssueMore: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusDot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  status_initializing: { backgroundColor: theme.colors.statusDotWarning },
  status_idle: { backgroundColor: theme.colors.statusDotSuccess },
  status_running: { backgroundColor: theme.colors.statusDotRunning },
  status_error: { backgroundColor: theme.colors.statusDotDanger },
  status_closed: { backgroundColor: theme.colors.foregroundExtraMuted },
}));
