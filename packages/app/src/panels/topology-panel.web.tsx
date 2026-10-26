import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Network } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";
import type { PanelRegistration } from "@/panels/panel-registry";
import {
  formatTopologyAssignment,
  TOPOLOGY_EDGE_LABELS,
  type TopologyEdge,
  type TopologyNode,
} from "@/panels/topology-model";
import { layoutProjectTopologyXFirst } from "@/panels/topology-layout";
import { useTopologyPanelDescriptor, useTopologyPanelState } from "@/panels/use-topology-panel";
import type { Theme } from "@/styles/theme";

interface FlowNodeData extends Record<string, unknown> {
  topologyNode: TopologyNode;
  parentTitle: string | null;
  relationship: TopologyEdge["kind"] | null;
  workspaceLabel: string | null;
  isLineageSeed: boolean;
  onViewLineage: (agentId: string) => void;
  issues: {
    id: string;
    title: string;
    status: BeadsIssue["status"] | null;
  }[];
}
type FlowNode = Node<FlowNodeData, "agent">;

const ThemedNetwork = withUnistyles(Network);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function AgentTopologyNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.topologyNode;
  const assignmentLabel = formatTopologyAssignment(node);
  const { onViewLineage } = data;
  // Pressable stops click propagation, so this never also opens the agent via onNodeClick.
  const handleViewLineage = useCallback(() => onViewLineage(node.id), [node.id, onViewLineage]);
  return (
    <View
      style={[styles.node, (selected || data.isLineageSeed) && styles.nodeSelected]}
      testID={`topology-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <View style={styles.nodeHeading}>
        <Text style={styles.roleLabel}>{node.role.toUpperCase()}</Text>
        <View style={styles.nodeHeadingActions}>
          {data.isLineageSeed ? null : (
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
        {node.status} · {node.provider}/{node.model ?? "default"}
      </Text>
      <Text style={styles.nodeMeta} numberOfLines={1}>
        Mode {node.modeId ?? "default"}
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
      {data.workspaceLabel ? (
        <Text style={styles.nodeWorkspace} numberOfLines={1}>
          {data.workspaceLabel}
        </Text>
      ) : null}
      {data.parentTitle && data.relationship ? (
        <Text style={styles.nodeRelation} numberOfLines={1}>
          {TOPOLOGY_EDGE_LABELS[data.relationship].byline} by {data.parentTitle}
        </Text>
      ) : null}
      {data.issues.length > 0 ? (
        <View style={styles.nodeIssues}>
          <Text style={styles.nodeIssuesLabel}>Assigned issues</Text>
          {data.issues.slice(0, 2).map((issue) => (
            <View key={issue.id} style={styles.nodeIssueRow}>
              <Text style={styles.nodeIssueTitle} numberOfLines={1}>
                {issue.title}
              </Text>
              <Text style={styles.nodeIssueStatus} numberOfLines={1}>
                {issue.status?.replace("_", " ") ?? "unknown"}
              </Text>
            </View>
          ))}
          {data.issues.length > 2 ? (
            <Text style={styles.nodeIssueMore}>+{data.issues.length - 2} more</Text>
          ) : null}
        </View>
      ) : null}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </View>
  );
}

const NODE_TYPES = { agent: AgentTopologyNode };
const FIT_VIEW_OPTIONS = { padding: 0.24, minZoom: 0.4, maxZoom: 1.15 };

function toFlowNodes(
  nodes: TopologyNode[],
  edges: readonly TopologyEdge[],
  issueById: ReadonlyMap<string, BeadsIssue>,
  lineage: {
    seedId: string | null;
    workspaceLabelOf: ((node: TopologyNode) => string | null) | null;
    onViewLineage: (agentId: string) => void;
  },
): FlowNode[] {
  const positions = layoutProjectTopologyXFirst(nodes, edges);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parentByChild = new Map(edges.map((edge) => [edge.target, edge]));
  return nodes.map((node) => {
    const parentEdge = parentByChild.get(node.id);
    const parent = parentEdge ? nodeById.get(parentEdge.source) : undefined;
    return {
      id: node.id,
      type: "agent",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        topologyNode: node,
        parentTitle: parent?.title ?? null,
        relationship: parentEdge?.kind ?? null,
        workspaceLabel: lineage.workspaceLabelOf?.(node) ?? null,
        isLineageSeed: node.id === lineage.seedId,
        onViewLineage: lineage.onViewLineage,
        issues: node.issueIds.map((issueId) => {
          const issue = issueById.get(issueId);
          return {
            id: issueId,
            title: issue?.title ?? issueId,
            status: issue?.status ?? null,
          };
        }),
      },
      draggable: false,
      connectable: false,
      deletable: false,
      selectable: true,
      ariaLabel: `Open ${node.title}, ${node.role}, ${node.status}, ${node.issueIds.length} assigned issues`,
    };
  });
}

function TopologyPanel() {
  const {
    topology,
    hydrated,
    openAgent,
    issueById,
    grantedIssueCount,
    issuesLoading,
    issuesError,
    projectName,
    lineage,
    viewLineage,
    showProjectTopology,
  } = useTopologyPanelState();
  const edges = useMemo<Edge[]>(
    () =>
      topology.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        label: TOPOLOGY_EDGE_LABELS[edge.kind].verb,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: edge.provenance === "inferred" ? { strokeDasharray: "5 5" } : undefined,
        animated: false,
        selectable: false,
      })),
    [topology.edges],
  );
  const lineageSeedId = lineage?.seedId ?? null;
  const workspaceLabelOf = lineage?.workspaceLabelOf ?? null;
  const nodes = useMemo(
    () =>
      toFlowNodes(topology.nodes, topology.edges, issueById, {
        seedId: lineageSeedId,
        workspaceLabelOf,
        onViewLineage: viewLineage,
      }),
    [issueById, lineageSeedId, topology.edges, topology.nodes, viewLineage, workspaceLabelOf],
  );
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: FlowNode) => openAgent(node.id),
    [openAgent],
  );

  if (!hydrated) {
    return (
      <View style={styles.centered} testID="project-topology-loading">
        <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
      </View>
    );
  }
  if (nodes.length === 0) {
    return (
      <View style={styles.centered} testID="project-topology-empty">
        <ThemedNetwork size={24} uniProps={mutedColorMapping} />
        <Text style={styles.emptyTitle}>No agents in topology</Text>
        <Text style={styles.emptyText}>Create role-bound agents to populate this topology.</Text>
      </View>
    );
  }
  return (
    <View style={styles.container} testID="project-topology-panel">
      <ReactFlow<FlowNode, Edge>
        key={lineageSeedId ? `lineage:${lineageSeedId}` : "project-horizontal"}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.25}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="currentColor" />
        <Panel position="top-left">
          <View style={styles.legend}>
            <Text style={styles.legendTitle}>
              {lineage ? `Lineage · ${lineage.seedTitle}` : `Project topology · ${projectName}`}
            </Text>
            <Text style={styles.legendMeta}>
              {nodes.length} agents · {edges.length} relationship
              {edges.length === 1 ? "" : "s"}
              {lineage
                ? ` · ${lineage.workspaceCount} workspace${lineage.workspaceCount === 1 ? "" : "s"}`
                : ""}
            </Text>
            <Text style={styles.legendMeta}>
              {grantedIssueCount} assigned issue
              {grantedIssueCount === 1 ? "" : "s"}
            </Text>
            <View style={styles.legendRules}>
              <Text style={styles.legendMeta}>
                Solid: exact supervision, delegation, or orchestration
              </Text>
            </View>
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
            {topology.warnings.length > 0 ? (
              <Text style={styles.warningText}>
                {topology.warnings.length} relationship
                {topology.warnings.length === 1 ? "" : "s"} need review
              </Text>
            ) : null}
            {issuesLoading && grantedIssueCount > 0 ? (
              <Text style={styles.legendMeta}>Loading issue details</Text>
            ) : null}
            {issuesError && grantedIssueCount > 0 ? (
              <Text style={styles.warningText}>
                Issue details unavailable; exact grants remain shown
              </Text>
            ) : null}
          </View>
        </Panel>
      </ReactFlow>
    </View>
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
  container: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface0,
  },
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
  },
  node: {
    width: 280,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  nodeSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
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
  nodeIssueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  nodeIssueTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  nodeIssueStatus: {
    maxWidth: 80,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
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
  legend: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  legendTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  legendMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  legendRules: { marginTop: theme.spacing[1], gap: 2 },
  warningText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
}));
