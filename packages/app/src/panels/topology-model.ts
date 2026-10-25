import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export type TopologyRole = PaseoRoleId | "unbound";
export type TopologyEdgeKind = "delegation" | "supervision" | "orchestration";

// An unbound parent (no role binding or launch receipt, e.g. a root orchestrator session)
// launching a child is orchestration, not a role contract the topology should flag.
export const TOPOLOGY_EDGE_LABELS: Record<TopologyEdgeKind, { verb: string; byline: string }> = {
  delegation: { verb: "delegates", byline: "Delegated" },
  supervision: { verb: "supervises", byline: "Supervised" },
  orchestration: { verb: "orchestrates", byline: "Orchestrated" },
};

export interface TopologyNode {
  id: string;
  title: string;
  shortId: string;
  role: TopologyRole;
  status: Agent["status"];
  provider: string;
  model: string | null;
  modeId: string | null;
  assignmentDisposition: string | null;
  launchProfile: Agent["launchProfile"] | null;
  workspaceId: string | null;
  requiresAttention: boolean;
  issueIds: string[];
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  kind: TopologyEdgeKind;
  provenance: "exact" | "inferred";
}

export type TopologyWarningCode =
  | "ambiguous_lead"
  | "ambiguous_supervisor"
  | "missing_parent"
  | "role_mismatch";

export interface TopologyWarning {
  code: TopologyWarningCode;
  agentId?: string;
}

export interface WorkspaceTopology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  warnings: TopologyWarning[];
  counts: Record<TopologyRole, number>;
}

export function formatTopologyAssignment(
  node: Pick<TopologyNode, "role" | "assignmentDisposition" | "launchProfile">,
): string | null {
  if (!node.launchProfile?.peerSubrole && !node.assignmentDisposition) return null;

  let roleLabel: string;
  if (node.launchProfile?.peerSubrole) {
    roleLabel = `Peer ${node.launchProfile.peerSubrole}`;
  } else if (node.role === "unbound") {
    roleLabel = "Unbound";
  } else {
    roleLabel = `${node.role[0].toUpperCase()}${node.role.slice(1)}`;
  }
  return node.assignmentDisposition
    ? `${roleLabel} · ${node.assignmentDisposition.replaceAll("_", " ")}`
    : roleLabel;
}

function roleOf(agent: Agent): TopologyRole {
  return agent.roleBinding?.roleId ?? agent.launchContract?.roleId ?? "unbound";
}

function titleOf(agent: Agent): string {
  const title = agent.title?.trim();
  return (
    title || `${roleOf(agent) === "unbound" ? "Agent" : roleOf(agent)} ${agent.id.slice(0, 8)}`
  );
}

function issueIdsOf(agent: Agent): string[] {
  const issueIds = agent.roleBinding?.assignment?.resourceGrants?.beadsIssueIds;
  return [...new Set(issueIds ?? [])].sort();
}

function assignmentParentAgentIdOf(agent: Agent): string | null {
  const roleBindingAssigner = agent.roleBinding?.assignment?.assigner;
  return roleBindingAssigner?.kind === "agent" ? roleBindingAssigner.agentId : null;
}

function parentAgentIdOf(agent: Agent): string | null {
  return agent.parentAgentId ?? assignmentParentAgentIdOf(agent);
}

function selectTopologyAgentIds(
  visibleAgents: readonly Agent[],
  seedAgentIds: readonly string[],
  includeDescendants = true,
): Set<string> {
  const visibleById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
  const selectedIds = new Set(seedAgentIds);

  for (const seedId of seedAgentIds) {
    let current = visibleById.get(seedId);
    const visited = new Set<string>();
    let parentAgentId = current ? parentAgentIdOf(current) : null;
    while (parentAgentId && !visited.has(parentAgentId)) {
      visited.add(parentAgentId);
      const parent = visibleById.get(parentAgentId);
      if (!parent) break;
      selectedIds.add(parent.id);
      current = parent;
      parentAgentId = parentAgentIdOf(current);
    }
  }

  if (!includeDescendants) return selectedIds;

  const descendantQueue = [...seedAgentIds];
  for (let index = 0; index < descendantQueue.length; index += 1) {
    const parentId = descendantQueue[index];
    for (const candidate of visibleAgents) {
      if (parentAgentIdOf(candidate) !== parentId || selectedIds.has(candidate.id)) continue;
      selectedIds.add(candidate.id);
      descendantQueue.push(candidate.id);
    }
  }
  return selectedIds;
}

export function buildWorkspaceTopology(
  agents: ReadonlyMap<string, Agent> | undefined,
  workspaceId: string,
): WorkspaceTopology {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  const visibleAgents = [...(agents?.values() ?? [])].filter((agent) => !agent.archivedAt);
  const workspaceSeedIds = visibleAgents
    .filter((agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizedWorkspaceId)
    .map((agent) => agent.id);
  const selectedIds = selectTopologyAgentIds(visibleAgents, workspaceSeedIds);
  return buildTopology(selectedInCreationOrder(visibleAgents, selectedIds));
}

export function buildProjectTopology(
  agents: ReadonlyMap<string, Agent> | undefined,
  workspaceIds: readonly string[],
): WorkspaceTopology {
  const normalizedWorkspaceIds = new Set(
    workspaceIds.map(normalizeWorkspaceOpaqueId).filter((id): id is string => id !== null),
  );
  const visibleAgents = [...(agents?.values() ?? [])].filter((agent) => !agent.archivedAt);
  const projectSeedIds = visibleAgents
    .filter((agent) =>
      normalizedWorkspaceIds.has(normalizeWorkspaceOpaqueId(agent.workspaceId) ?? ""),
    )
    .map((agent) => agent.id);
  const selectedIds = selectTopologyAgentIds(visibleAgents, projectSeedIds, false);
  return buildTopology(selectedInCreationOrder(visibleAgents, selectedIds));
}

/**
 * The derivation tree rooted at one agent: its exact ancestors plus every descendant,
 * followed across workspace and project boundaries.
 */
export function buildLineageTopology(
  agents: ReadonlyMap<string, Agent> | undefined,
  seedAgentId: string,
): WorkspaceTopology {
  const visibleAgents = [...(agents?.values() ?? [])].filter((agent) => !agent.archivedAt);
  const seedIds = visibleAgents.some((agent) => agent.id === seedAgentId) ? [seedAgentId] : [];
  const selectedIds = selectTopologyAgentIds(visibleAgents, seedIds);
  return buildTopology(selectedInCreationOrder(visibleAgents, selectedIds));
}

export function buildHostTopology(
  agents: ReadonlyMap<string, Agent> | undefined,
): WorkspaceTopology {
  const visibleAgents = [...(agents?.values() ?? [])].filter((agent) => !agent.archivedAt);
  return buildTopology(
    selectedInCreationOrder(visibleAgents, new Set(visibleAgents.map((agent) => agent.id))),
  );
}

function selectedInCreationOrder(
  visibleAgents: readonly Agent[],
  selectedIds: ReadonlySet<string>,
): Agent[] {
  return visibleAgents
    .filter((agent) => selectedIds.has(agent.id))
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
    );
}

function buildTopology(topologyAgents: readonly Agent[]): WorkspaceTopology {
  const nodes = topologyAgents.map<TopologyNode>((agent) => ({
    id: agent.id,
    title: titleOf(agent),
    shortId: agent.id.slice(0, 8),
    role: roleOf(agent),
    status: agent.status,
    provider: agent.provider,
    model: agent.model,
    modeId: agent.currentModeId,
    assignmentDisposition: agent.roleBinding?.assignment?.disposition ?? null,
    launchProfile: agent.launchProfile ?? null,
    workspaceId: agent.workspaceId ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    issueIds: issueIdsOf(agent),
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceById = new Map(topologyAgents.map((agent) => [agent.id, agent]));
  const edges: TopologyEdge[] = [];
  const warnings: TopologyWarning[] = [];

  for (const agent of topologyAgents) {
    const parentAgentId = parentAgentIdOf(agent);
    if (!parentAgentId) continue;
    const parent = sourceById.get(parentAgentId);
    if (!parent || !nodeById.has(parent.id)) {
      warnings.push({ code: "missing_parent", agentId: agent.id });
      continue;
    }
    const isOrchestration = roleOf(parent) === "unbound";
    const isSupervision = roleOf(parent) === "supervisor" && roleOf(agent) === "lead";
    const isDelegation = roleOf(parent) === "lead" && roleOf(agent) === "peer";
    let kind: TopologyEdgeKind = "delegation";
    if (isOrchestration) kind = "orchestration";
    else if (isSupervision) kind = "supervision";
    edges.push({
      id: `${kind}:${parent.id}:${agent.id}`,
      source: parent.id,
      target: agent.id,
      kind,
      provenance: "exact",
    });
    if (!isOrchestration && !isSupervision && !isDelegation) {
      warnings.push({ code: "role_mismatch", agentId: agent.id });
    }
  }

  const counts: Record<TopologyRole, number> = {
    lead: 0,
    peer: 0,
    supervisor: 0,
    unbound: 0,
  };
  for (const node of nodes) counts[node.role] += 1;
  return { nodes, edges, warnings, counts };
}
