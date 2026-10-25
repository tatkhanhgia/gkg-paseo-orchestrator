import { Network } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";
import { useHostFeature } from "@/runtime/host-features";
import { useIssuesQuery } from "@/issues/data";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useProjectWorkspaceIds, useWorkspace } from "@/stores/session-store-hooks";
import {
  buildLineageTopology,
  buildProjectTopology,
  type TopologyNode,
} from "@/panels/topology-model";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

function formatWorkspaceLabel(
  workspaces: Map<string, WorkspaceDescriptor> | undefined,
  workspaceId: string | null,
): string {
  if (!workspaceId) return "No workspace";
  const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId });
  const workspace = key ? workspaces?.get(key) : undefined;
  if (!workspace) return workspaceId;
  return `${workspace.projectDisplayName} · ${workspace.title?.trim() || workspace.name}`;
}

export function useTopologyPanelDescriptor(
  _target: { kind: "topology" },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const workspace = useWorkspace(context.serverId, context.workspaceId);
  const projectId = workspace?.projectId ?? "";
  const projectWorkspaceIds = useProjectWorkspaceIds(context.serverId, projectId);
  const count = useSessionStore((state) => {
    const agents = state.sessions[context.serverId]?.agents;
    if (!agents) return 0;
    return buildProjectTopology(agents, projectWorkspaceIds).nodes.length;
  });
  return {
    label: "Project topology",
    subtitle: `${count} agent${count === 1 ? "" : "s"}`,
    tooltip: workspace ? `${workspace.projectDisplayName} topology` : "Project topology",
    titleState: "ready",
    icon: Network,
    statusBucket: null,
  };
}

export function useTopologyPanelState() {
  const { serverId, workspaceId, openTab } = usePaneContext();
  const workspace = useWorkspace(serverId, workspaceId);
  const supportsIssues = useHostFeature(serverId, "beadsIssues");
  const projectId = workspace?.projectId ?? "";
  const projectWorkspaceIds = useProjectWorkspaceIds(serverId, projectId);
  const issuesQuery = useIssuesQuery(
    serverId,
    projectId,
    "all",
    supportsIssues && projectId.length > 0,
  );
  const session = useSessionStore(
    useShallow((state) => ({
      agents: state.sessions[serverId]?.agents,
      hydrated: state.sessions[serverId]?.hasHydratedAgents ?? false,
    })),
  );
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const [lineageSeedId, setLineageSeedId] = useState<string | null>(null);
  const lineageSeedAgent = lineageSeedId ? session.agents?.get(lineageSeedId) : undefined;
  // An archived or vanished seed falls back to the project view instead of an empty lineage.
  const lineageSeed =
    lineageSeedAgent && !lineageSeedAgent.archivedAt ? lineageSeedAgent : undefined;
  const topology = useMemo(
    () =>
      lineageSeed
        ? buildLineageTopology(session.agents, lineageSeed.id)
        : buildProjectTopology(session.agents, projectWorkspaceIds),
    [lineageSeed, projectWorkspaceIds, session.agents],
  );
  const lineage = useMemo(() => {
    if (!lineageSeed) return null;
    const seedNode = topology.nodes.find((node) => node.id === lineageSeed.id);
    const workspaceLabelByNodeId = new Map<string, string>(
      topology.nodes.map((node) => [node.id, formatWorkspaceLabel(workspaces, node.workspaceId)]),
    );
    return {
      seedId: lineageSeed.id,
      seedTitle: seedNode?.title ?? lineageSeed.id.slice(0, 8),
      workspaceCount: new Set(topology.nodes.map((node) => node.workspaceId)).size,
      workspaceLabelOf: (node: TopologyNode) => workspaceLabelByNodeId.get(node.id) ?? null,
    };
  }, [lineageSeed, topology.nodes, workspaces]);
  const viewLineage = useCallback((agentId: string) => setLineageSeedId(agentId), []);
  const showProjectTopology = useCallback(() => setLineageSeedId(null), []);
  const issueById = useMemo(
    () =>
      new Map<string, BeadsIssue>(
        (issuesQuery.data?.issues ?? []).map((issue) => [issue.id, issue]),
      ),
    [issuesQuery.data?.issues],
  );
  const grantedIssueCount = useMemo(
    () => new Set(topology.nodes.flatMap((node) => node.issueIds)).size,
    [topology.nodes],
  );
  const openAgent = useCallback(
    (agentId: string) => openTab({ kind: "agent", agentId }),
    [openTab],
  );
  return {
    ...session,
    topology,
    projectName: workspace?.projectDisplayName ?? "Project",
    lineage,
    viewLineage,
    showProjectTopology,
    openAgent,
    issueById,
    grantedIssueCount,
    issuesLoading: issuesQuery.isLoading,
    issuesError: issuesQuery.error,
  };
}
