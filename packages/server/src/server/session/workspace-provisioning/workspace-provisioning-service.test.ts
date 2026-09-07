import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import { createWorkspaceProvisioningService } from "./workspace-provisioning-service.js";

const temporaryRoots: string[] = [];

function project(projectId: string, rootPath: string) {
  return {
    projectId,
    rootPath,
    kind: "non_git" as const,
    displayName: projectId,
    projectKey: null,
    workGraphId: null,
    customName: null,
    customIconRevision: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    archivedAt: null,
  };
}

function workspace(workspaceId: string, projectId: string, cwd: string) {
  return {
    workspaceId,
    projectId,
    cwd,
    kind: "directory" as const,
    displayName: workspaceId,
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
    labels: [],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace provisioning Project Harness target", () => {
  it("anchors the target to the registered project/workspace identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-harness-provisioning-test-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "child"), { recursive: true });
    const registeredProject = project("prj_target", root);
    const registeredWorkspace = workspace("wks_target", registeredProject.projectId, root);
    const projectRegistry = {
      get: async (projectId: string) =>
        projectId === registeredProject.projectId ? registeredProject : null,
      list: async () => [registeredProject],
    } as unknown as ProjectRegistry;
    const workspaceRegistry = {
      get: async (workspaceId: string) =>
        workspaceId === registeredWorkspace.workspaceId ? registeredWorkspace : null,
    } as unknown as WorkspaceRegistry;
    const service = createWorkspaceProvisioningService({
      projectRegistry,
      workspaceRegistry,
      workspaceGitService: {
        getCheckout: async () => ({ isGit: false }),
        getSnapshot: async () => null,
        peekSnapshot: async () => null,
      } as never,
      logger: pino({ level: "silent" }),
    });

    await expect(
      service.resolveProjectHarnessTarget({
        projectId: registeredProject.projectId,
        workspaceId: registeredWorkspace.workspaceId,
        cwd: join(root, "child"),
      }),
    ).resolves.toMatchObject({
      projectId: registeredProject.projectId,
      workspaceId: registeredWorkspace.workspaceId,
      projectRoot: root,
      workspaceRoot: root,
      cwd: join(root, "child"),
    });
  });

  it("fails closed for a registered child project inside the owning workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-harness-topology-test-"));
    temporaryRoots.push(root);
    const childRoot = join(root, "child");
    await mkdir(childRoot, { recursive: true });
    const parent = project("prj_parent", root);
    const child = project("prj_child", childRoot);
    const owningWorkspace = workspace("wks_parent", parent.projectId, root);
    const projectRegistry = {
      get: async (projectId: string) =>
        [parent, child].find((item) => item.projectId === projectId) ?? null,
      list: async () => [parent, child],
    } as unknown as ProjectRegistry;
    const workspaceRegistry = {
      get: async (workspaceId: string) =>
        workspaceId === owningWorkspace.workspaceId ? owningWorkspace : null,
    } as unknown as WorkspaceRegistry;
    const service = createWorkspaceProvisioningService({
      projectRegistry,
      workspaceRegistry,
      workspaceGitService: {
        getCheckout: async () => ({ isGit: false }),
        getSnapshot: async () => null,
        peekSnapshot: async () => null,
      } as never,
      logger: pino({ level: "silent" }),
    });

    await expect(
      service.resolveProjectHarnessTarget({
        projectId: parent.projectId,
        workspaceId: owningWorkspace.workspaceId,
        cwd: childRoot,
      }),
    ).rejects.toThrow("harness_project_registered_topology_mismatch");
  });
});
