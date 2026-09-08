import type { TopologyNode } from "@/panels/topology-model";

export type TopologyStatusFilter = "all" | TopologyNode["status"];

export const TOPOLOGY_STATUS_FILTERS: readonly TopologyStatusFilter[] = [
  "all",
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
];

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function matchesQuery(node: TopologyNode, query: string): boolean {
  if (!query) return true;
  return (
    node.title.toLowerCase().includes(query) ||
    node.shortId.toLowerCase().includes(query) ||
    node.provider.toLowerCase().includes(query)
  );
}

function matchesStatus(node: TopologyNode, status: TopologyStatusFilter): boolean {
  return status === "all" || node.status === status;
}

// "all" or a resolved project id (see resolveProjectId in host-topology-screen.tsx);
// "unassigned" groups agents whose workspace has no known project.
export type TopologyProjectFilter = "all" | string;

function matchesProject(
  node: TopologyNode,
  projectId: TopologyProjectFilter,
  resolveProjectId: (node: TopologyNode) => string,
): boolean {
  return projectId === "all" || resolveProjectId(node) === projectId;
}

// Pure filtering only: never mutates topology state, only narrows what a screen renders.
// `resolveProjectId` is optional because project filtering requires a workspace lookup
// the screen owns; omitting it is only valid when `filters.projectId` is "all" (or unset).
export function filterTopologyNodes(
  nodes: readonly TopologyNode[],
  filters: { query: string; status: TopologyStatusFilter; projectId?: TopologyProjectFilter },
  resolveProjectId: (node: TopologyNode) => string = () => "unassigned",
): TopologyNode[] {
  const query = normalizeQuery(filters.query);
  const projectId = filters.projectId ?? "all";
  return nodes.filter(
    (node) =>
      matchesQuery(node, query) &&
      matchesStatus(node, filters.status) &&
      matchesProject(node, projectId, resolveProjectId),
  );
}
