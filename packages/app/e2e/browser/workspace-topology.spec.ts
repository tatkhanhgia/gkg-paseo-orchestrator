import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

function assignmentFor(roleId: PaseoRoleId, issueIds: string[] = []): AssignmentEnvelope {
  const disposition = {
    lead: "lead-direct",
    peer: "peer-execution",
    supervisor: "supervision",
  } as const;
  return {
    version: 1,
    disposition: disposition[roleId],
    objective: `Exercise the ${roleId} topology projection.`,
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Expose the daemon-issued role and relationship in the workspace topology.",
    handbackAndStop: "Stop after topology verification or a material blocker.",
    ...(issueIds.length > 0 ? { resourceGrants: { beadsIssueIds: issueIds } } : {}),
  };
}

test.describe("workspace topology", () => {
  test("projects daemon-bound roles and opens an agent from the graph", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "topology-e2e-" });
    try {
      const lead = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Topology Lead",
        modeId: "load-test",
        model: "ten-second-stream",
        roleId: "lead",
        assignment: assignmentFor("lead"),
      });
      const peer = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Topology Peer",
        modeId: "load-test",
        model: "ten-second-stream",
        roleId: "peer",
        assignment: assignmentFor("peer", ["ps-topology-e2e"]),
        labels: { [PARENT_AGENT_ID_LABEL]: lead.id },
      });
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Topology Supervisor",
        modeId: "load-test",
        model: "ten-second-stream",
        roleId: "supervisor",
        assignment: assignmentFor("supervisor"),
      });

      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await expect(page.getByTestId("workspace-header-topology")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("workspace-header-issues")).toBeVisible();
      await page.getByTestId("workspace-header-topology").click();

      const topology = page.getByTestId("project-topology-panel");
      await expect(topology).toBeVisible({ timeout: 30_000 });
      await expect(topology.getByText("3 agents · 1 relationship", { exact: true })).toBeVisible();
      await expect(topology.getByLabel(/Open Topology Lead, lead,/u)).toBeVisible();
      await expect(topology.getByLabel(/Open Topology Peer, peer,/u)).toBeVisible();
      await expect(topology.getByLabel(/Open Topology Supervisor, supervisor,/u)).toBeVisible();
      await expect(topology.getByText("delegates", { exact: true })).toBeVisible();
      await expect(topology.getByText("supervises", { exact: true })).toHaveCount(0);
      await expect(topology.getByText("1 assigned issue", { exact: true })).toBeVisible();
      await expect(topology.getByText("ps-topology-e2e", { exact: true })).toBeVisible();

      await topology.getByLabel(/Open Topology Peer, peer,/u).click();
      await expect(page.getByTestId(`workspace-tab-agent_${peer.id}`).first()).toBeVisible({
        timeout: 30_000,
      });
      await page.getByTestId("workspace-header-issues").click();
      await expect(page.getByTestId("issues-screen")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("follows an unbound root's lineage into another project's workspace", async ({ page }) => {
    test.setTimeout(120_000);
    const rootWorkspace = await seedWorkspace({ repoPrefix: "topology-lineage-root-" });
    let projectWorkspace: SeededWorkspace | null = null;
    try {
      projectWorkspace = await seedWorkspace({ repoPrefix: "topology-lineage-project-" });
      const root = await rootWorkspace.client.createAgent({
        provider: "mock",
        cwd: rootWorkspace.repoPath,
        workspaceId: rootWorkspace.workspaceId,
        title: "Lineage Root",
        modeId: "load-test",
        model: "ten-second-stream",
      });
      const lead = await projectWorkspace.client.createAgent({
        provider: "mock",
        cwd: projectWorkspace.repoPath,
        workspaceId: projectWorkspace.workspaceId,
        title: "Lineage Lead",
        modeId: "load-test",
        model: "ten-second-stream",
        roleId: "lead",
        assignment: assignmentFor("lead"),
        labels: { [PARENT_AGENT_ID_LABEL]: root.id },
      });
      await projectWorkspace.client.createAgent({
        provider: "mock",
        cwd: projectWorkspace.repoPath,
        workspaceId: projectWorkspace.workspaceId,
        title: "Lineage Peer",
        modeId: "load-test",
        model: "ten-second-stream",
        roleId: "peer",
        assignment: assignmentFor("peer"),
        labels: { [PARENT_AGENT_ID_LABEL]: lead.id },
      });

      await page.goto(buildHostWorkspaceRoute(getServerId(), rootWorkspace.workspaceId));
      await expect(page.getByTestId("workspace-header-topology")).toBeVisible({
        timeout: 30_000,
      });
      await page.getByTestId("workspace-header-topology").click();

      const topology = page.getByTestId("project-topology-panel");
      await expect(topology).toBeVisible({ timeout: 30_000 });
      await expect(topology.getByText("1 agents · 0 relationships", { exact: true })).toBeVisible();
      await expect(topology.getByLabel(/Open Lineage Lead, lead,/u)).toHaveCount(0);

      await topology.getByTestId(`topology-view-lineage-${root.id}`).click();
      await expect(topology.getByText("Lineage · Lineage Root", { exact: true })).toBeVisible();
      await expect(
        topology.getByText("3 agents · 2 relationships · 2 workspaces", { exact: true }),
      ).toBeVisible();
      await expect(topology.getByLabel(/Open Lineage Lead, lead,/u)).toBeVisible();
      await expect(topology.getByLabel(/Open Lineage Peer, peer,/u)).toBeVisible();
      await expect(topology.getByText("orchestrates", { exact: true })).toBeVisible();
      await expect(topology.getByText("delegates", { exact: true })).toBeVisible();
      await expect(
        topology.getByText("Orchestrated by Lineage Root", { exact: true }),
      ).toBeVisible();
      await expect(topology.getByText(/need review/u)).toHaveCount(0);

      await topology.getByTestId("topology-show-project").click();
      await expect(topology.getByText("1 agents · 0 relationships", { exact: true })).toBeVisible();
    } finally {
      await projectWorkspace?.cleanup();
      await rootWorkspace.cleanup();
    }
  });
});
