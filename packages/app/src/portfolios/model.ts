import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";

export interface PortfolioProjectMember {
  projectId: string;
  project: HostProjectListItem | null;
  name: string;
}

export function buildPortfolioProjectMembers(input: {
  portfolio: PortfolioRecord;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): PortfolioProjectMember[] {
  const projectById = new Map<string, HostProjectListItem>();
  for (const project of input.projects) {
    const projectId = getHostProjectId(project, input.serverId);
    if (projectId) projectById.set(projectId, project);
  }

  return input.portfolio.projectIds.map((projectId) => {
    const project = projectById.get(projectId) ?? null;
    return {
      projectId,
      project,
      name: project?.projectName ?? projectId,
    };
  });
}

export function buildAvailablePortfolioProjects(input: {
  portfolios: readonly PortfolioRecord[];
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem[] {
  const assignedProjectIds = new Set(input.portfolios.flatMap((portfolio) => portfolio.projectIds));

  return input.projects
    .filter((project) => {
      const projectId = getHostProjectId(project, input.serverId);
      return Boolean(projectId && !assignedProjectIds.has(projectId));
    })
    .toSorted(
      (left, right) =>
        left.projectName.localeCompare(right.projectName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) || left.viewKey.localeCompare(right.viewKey),
    );
}
