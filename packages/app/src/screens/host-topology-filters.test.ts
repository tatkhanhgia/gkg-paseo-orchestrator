import { describe, expect, it } from "vitest";
import type { TopologyNode } from "@/panels/topology-model";
import { filterTopologyNodes } from "./host-topology-filters";

function buildNode(overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id: "agent-1",
    title: "Peer agent",
    shortId: "abc123",
    role: "peer",
    status: "running",
    provider: "claude",
    model: null,
    modeId: null,
    assignmentDisposition: null,
    launchProfile: null,
    workspaceId: null,
    requiresAttention: false,
    issueIds: [],
    ...overrides,
  };
}

describe("filterTopologyNodes", () => {
  it("returns every node when there is no query and status is 'all'", () => {
    const nodes = [buildNode({ id: "a" }), buildNode({ id: "b", status: "idle" })];
    expect(filterTopologyNodes(nodes, { query: "", status: "all" })).toEqual(nodes);
  });

  it("matches a query against the title case-insensitively", () => {
    const nodes = [
      buildNode({ id: "a", title: "Lead orchestrator" }),
      buildNode({ id: "b", title: "Peer worker" }),
    ];
    const result = filterTopologyNodes(nodes, { query: "lead", status: "all" });
    expect(result.map((node) => node.id)).toEqual(["a"]);
  });

  it("matches a query against the short id and provider", () => {
    const nodes = [
      buildNode({ id: "a", shortId: "xyz789", title: "Unrelated title", provider: "codex" }),
      buildNode({ id: "b", shortId: "zzz000", title: "Also unrelated", provider: "claude" }),
    ];
    expect(filterTopologyNodes(nodes, { query: "xyz789", status: "all" }).map((n) => n.id)).toEqual(
      ["a"],
    );
    expect(filterTopologyNodes(nodes, { query: "codex", status: "all" }).map((n) => n.id)).toEqual([
      "a",
    ]);
  });

  it("filters by status", () => {
    const nodes = [
      buildNode({ id: "a", status: "running" }),
      buildNode({ id: "b", status: "error" }),
      buildNode({ id: "c", status: "closed" }),
    ];
    expect(filterTopologyNodes(nodes, { query: "", status: "error" }).map((n) => n.id)).toEqual([
      "b",
    ]);
  });

  it("combines query and status filters", () => {
    const nodes = [
      buildNode({ id: "a", title: "Lead orchestrator", status: "running" }),
      buildNode({ id: "b", title: "Lead orchestrator", status: "error" }),
    ];
    const result = filterTopologyNodes(nodes, { query: "lead", status: "error" });
    expect(result.map((node) => node.id)).toEqual(["b"]);
  });

  it("returns no nodes when nothing matches", () => {
    const nodes = [buildNode({ id: "a", title: "Peer agent" })];
    expect(filterTopologyNodes(nodes, { query: "nonexistent", status: "all" })).toEqual([]);
  });

  it("ignores the project filter when resolveProjectId is omitted and projectId is 'all'", () => {
    const nodes = [buildNode({ id: "a" }), buildNode({ id: "b" })];
    expect(filterTopologyNodes(nodes, { query: "", status: "all", projectId: "all" })).toEqual(
      nodes,
    );
  });

  it("filters by a resolved project id", () => {
    const nodes = [
      buildNode({ id: "a", workspaceId: "ws-1" }),
      buildNode({ id: "b", workspaceId: "ws-2" }),
      buildNode({ id: "c", workspaceId: null }),
    ];
    const projectByWorkspace = new Map([
      ["ws-1", "project-alpha"],
      ["ws-2", "project-beta"],
    ]);
    const resolveProjectId = (node: TopologyNode) =>
      node.workspaceId ? (projectByWorkspace.get(node.workspaceId) ?? "unassigned") : "unassigned";
    expect(
      filterTopologyNodes(
        nodes,
        { query: "", status: "all", projectId: "project-alpha" },
        resolveProjectId,
      ).map((node) => node.id),
    ).toEqual(["a"]);
    expect(
      filterTopologyNodes(
        nodes,
        { query: "", status: "all", projectId: "unassigned" },
        resolveProjectId,
      ).map((node) => node.id),
    ).toEqual(["c"]);
  });
});
