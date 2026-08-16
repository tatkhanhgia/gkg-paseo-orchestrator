import { describe, expect, it } from "vitest";
import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";
import type { HostProjectListItem } from "@/projects/host-projects";
import { buildAvailablePortfolioProjects, buildPortfolioProjectMembers } from "./model";

function project(projectId: string, projectName: string): HostProjectListItem {
  return {
    viewKey: `host:${projectId}`,
    projectKey: null,
    projectName,
    projectKind: "git",
    iconWorkingDir: `/projects/${projectId}`,
    hosts: [
      {
        serverId: "host-1",
        projectId,
        iconWorkingDir: `/projects/${projectId}`,
        worktreeSupport: "supported",
      },
    ],
    workspaceKeys: [],
  };
}

function portfolio(id: string, projectIds: string[]): PortfolioRecord {
  return {
    id,
    name: id,
    projectIds,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("portfolio project model", () => {
  it("keeps portfolio membership order and exposes missing project rows", () => {
    const members = buildPortfolioProjectMembers({
      portfolio: portfolio("portfolio", ["prj_beta", "prj_missing", "prj_alpha"]),
      projects: [project("prj_alpha", "Alpha"), project("prj_beta", "Beta")],
      serverId: "host-1",
    });

    expect(members.map(({ projectId, name }) => ({ projectId, name }))).toEqual([
      { projectId: "prj_beta", name: "Beta" },
      { projectId: "prj_missing", name: "prj_missing" },
      { projectId: "prj_alpha", name: "Alpha" },
    ]);
  });

  it("offers only unassigned projects in stable name order", () => {
    const projects = [
      project("prj_zulu", "Zulu"),
      project("prj_alpha", "Alpha"),
      project("prj_beta", "Beta"),
    ];

    const available = buildAvailablePortfolioProjects({
      portfolios: [portfolio("first", ["prj_beta"]), portfolio("second", ["prj_zulu"])],
      projects,
      serverId: "host-1",
    });

    expect(available.map((entry) => entry.projectName)).toEqual(["Alpha"]);
  });
});
