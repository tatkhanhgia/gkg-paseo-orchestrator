import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
} from "./harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  writeHarnessProjectMetadata,
} from "./harness-project-metadata-file.js";
import { createProjectHarnessBindingService } from "./harness-binding-service.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const REQUEST = {
  scope: "R1 bounded Supervisor notebook authority",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

function makeService(projectRoot: string) {
  const project = { projectId: "project-1", rootPath: projectRoot, archivedAt: null };
  return createProjectHarnessBindingService({
    workspaceRegistry: {
      get: async (workspaceId) =>
        ({ workspaceId, projectId: "project-1", cwd: projectRoot, archivedAt: null }) as never,
    },
    projectRegistry: {
      get: async (projectId) => (projectId === project.projectId ? project : null) as never,
      list: async () => [project] as never,
    },
  });
}

function releaseInput(
  projectRoot: string,
  claim: { notebookId: string; location: string; designatedWriterId: string },
) {
  const metadata = inspectHarnessProjectMetadata(
    projectRoot,
    DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  );
  if (metadata.status !== "valid") throw new Error("test metadata must be valid");
  return {
    projectId: "project-1",
    workspaceId: "workspace-1",
    cwd: projectRoot,
    notebookId: claim.notebookId,
    location: claim.location,
    designatedWriterId: claim.designatedWriterId,
    expectedRevision: { status: "regular" as const, ...metadata.revision },
  };
}

describe("Project Harness binding service", () => {
  test("prepares a Supervisor read context without granting a writer and does not write metadata", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-read-"));
    tempDirs.push(projectRoot);
    const service = makeService(projectRoot);

    const prepared = await service.prepare({
      agentId: "supervisor-read-only",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
    });

    expect(prepared.notebookGrant).toBeUndefined();
    expect(prepared.context.notebook).toMatchObject({
      notebookId: expect.stringMatching(/^nb_[a-f0-9]{24}$/u),
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      projectScope: "project:project-1",
      reportingTarget: "project:project-1:supervisor-notebook",
      designatedWriterId: null,
      expiresAt: null,
    });
    expect(prepared.context.workspaceRoot).toBe(projectRoot);
    expect(
      inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");
    await prepared.commit();
    expect(
      inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");
  });

  test("commits a pending writer claim only after admission and safely rolls it back", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-claim-"));
    tempDirs.push(projectRoot);
    const service = makeService(projectRoot);
    const prepared = await service.prepare({
      agentId: "supervisor-writer-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
      request: REQUEST,
    });

    expect(
      inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");
    expect(prepared.notebookGrant).toMatchObject({
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      designatedWriterId: "supervisor-writer-1",
    });
    await prepared.commit();
    const committed = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(committed.status).toBe("valid");
    expect(
      committed.status === "valid" ? committed.metadata.supervisorNotebook : null,
    ).toMatchObject({
      designatedWriterId: "supervisor-writer-1",
      scope: REQUEST.scope,
    });

    await prepared.rollback();
    const rolledBack = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(
      rolledBack.status === "valid" ? rolledBack.metadata.supervisorNotebook : null,
    ).toBeUndefined();
  });

  test("rejects a malformed or non-future expiry before preparing a writer claim", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-expiry-"));
    tempDirs.push(projectRoot);
    const service = makeService(projectRoot);

    await expect(
      service.prepare({
        agentId: "supervisor-writer-expired",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        cwd: projectRoot,
        request: { scope: REQUEST.scope, expiresAt: "2000-01-01T00:00:00.000Z" },
      }),
    ).rejects.toThrow("notebook_grant_expiry_not_future");
    expect(
      inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH).status,
    ).toBe("missing");
  });

  test("reuses an authorized custom location and rejects writer contention", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-custom-"));
    tempDirs.push(projectRoot);
    const customClaim = {
      notebookId: "nb_custom-authorized",
      location: "docs/custom/SUPERVISOR.md",
      designatedWriterId: "supervisor-writer-1",
      scope: "old scope",
      expiresAt: REQUEST.expiresAt,
      establishedAt: "2026-09-07T00:00:00.000Z",
    };
    const written = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: { supervisorNotebook: customClaim },
      expectedRevision: null,
      writerId: customClaim.designatedWriterId,
    });
    expect(written.ok).toBe(true);

    const service = makeService(projectRoot);
    const prepared = await service.prepare({
      agentId: "supervisor-writer-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
      request: REQUEST,
    });
    expect(prepared.context.notebook).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
    });
    expect(prepared.notebookGrant?.location).toBe(customClaim.location);

    await expect(
      service.prepare({
        agentId: "supervisor-writer-2",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        cwd: projectRoot,
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_writer_conflict/u);
  });

  test("retains custom notebook identity across writer release and successor preparation", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-custom-release-"));
    tempDirs.push(projectRoot);
    const customClaim = {
      notebookId: "nb_custom-release",
      location: "docs/custom/RELEASE-PRESERVED.md",
      designatedWriterId: "supervisor-writer-1",
      scope: REQUEST.scope,
      expiresAt: REQUEST.expiresAt,
      establishedAt: "2026-09-07T00:00:00.000Z",
    };
    const written = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: { supervisorNotebook: customClaim },
      expectedRevision: null,
      writerId: customClaim.designatedWriterId,
    });
    expect(written.ok).toBe(true);
    const service = makeService(projectRoot);

    const oldReader = await service.prepare({
      agentId: "supervisor-reader-old",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
    });
    expect(oldReader.context.notebook).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      designatedWriterId: null,
    });
    await expect(
      service.prepare({
        agentId: "supervisor-writer-2",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        cwd: projectRoot,
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_writer_conflict/u);

    const released = await service.release(releaseInput(projectRoot, customClaim));
    expect(released).toMatchObject({
      projectId: "project-1",
      workspaceId: "workspace-1",
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      releasedWriterId: customClaim.designatedWriterId,
      nextStep: "fresh_supervisor_role_first",
    });
    const afterRelease = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(afterRelease.status === "valid" ? afterRelease.metadata : null).toMatchObject({
      supervisorNotebookIdentity: {
        notebookId: customClaim.notebookId,
        location: customClaim.location,
      },
    });
    expect(afterRelease.status === "valid" ? afterRelease.metadata.supervisorNotebook : null).toBe(
      undefined,
    );

    const freshReader = await service.prepare({
      agentId: "supervisor-reader-new",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
    });
    expect(freshReader.context.notebook).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      designatedWriterId: null,
    });
    expect(oldReader.context.notebook).toEqual(freshReader.context.notebook);

    const successor = await service.prepare({
      agentId: "supervisor-writer-2",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
      request: REQUEST,
    });
    expect(successor.context.notebook).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      designatedWriterId: "supervisor-writer-2",
    });
    expect(successor.notebookGrant).toMatchObject({
      notebookId: customClaim.notebookId,
      location: customClaim.location,
      designatedWriterId: "supervisor-writer-2",
    });
  });

  test("rejects a durably configured notebook location that crosses a symlink", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-symlink-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-outside-"));
    tempDirs.push(projectRoot, outsideRoot);
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    symlinkSync(outsideRoot, join(projectRoot, "docs", "unsafe"));
    const unsafeClaim = {
      notebookId: "nb_unsafe",
      location: "docs/unsafe/SUPERVISOR.md",
      designatedWriterId: "supervisor-writer-1",
      scope: REQUEST.scope,
      expiresAt: REQUEST.expiresAt,
      establishedAt: "2026-09-07T00:00:00.000Z",
    };
    const written = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: { supervisorNotebook: unsafeClaim },
      expectedRevision: null,
      writerId: unsafeClaim.designatedWriterId,
    });
    expect(written.ok).toBe(true);

    await expect(
      makeService(projectRoot).prepare({
        agentId: unsafeClaim.designatedWriterId,
        roleId: "supervisor",
        workspaceId: "workspace-1",
        cwd: projectRoot,
        request: REQUEST,
      }),
    ).rejects.toThrow(/harness_binding_notebook_location_unsafe/u);
  });

  test("requires the exact current writer identity and metadata revision for release", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-release-cas-"));
    tempDirs.push(projectRoot);
    const service = makeService(projectRoot);
    const prepared = await service.prepare({
      agentId: "supervisor-writer-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
      request: REQUEST,
    });
    await prepared.commit();
    const current = releaseInput(projectRoot, {
      notebookId: prepared.context.notebook?.notebookId ?? "",
      location: prepared.context.notebook?.location ?? DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
      designatedWriterId: "supervisor-writer-1",
    });

    await expect(
      service.release({
        ...current,
        expectedRevision: { ...current.expectedRevision, sha256: "b".repeat(64) },
      }),
    ).rejects.toThrow("notebook_release_stale_metadata");
    await expect(
      service.release({ ...current, designatedWriterId: "supervisor-writer-2" }),
    ).rejects.toThrow("notebook_release_writer_conflict");
    const stillClaimed = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(
      stillClaimed.status === "valid" ? stillClaimed.metadata.supervisorNotebook : null,
    ).toMatchObject({ designatedWriterId: "supervisor-writer-1" });
  });

  test("supports authorized rebind/release and rejects malformed metadata", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-recovery-"));
    tempDirs.push(projectRoot);
    const service = makeService(projectRoot);
    const first = await service.prepare({
      agentId: "supervisor-writer-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      cwd: projectRoot,
      request: REQUEST,
    });
    await first.commit();

    const rebound = await service.rebind({
      workspaceId: "workspace-1",
      currentWriterId: "supervisor-writer-1",
      newWriterId: "supervisor-writer-2",
      scope: "rebound scope",
      expiresAt: REQUEST.expiresAt,
    });
    expect(rebound.designatedWriterId).toBe("supervisor-writer-2");
    await expect(
      service.rebind({
        workspaceId: "workspace-1",
        currentWriterId: "supervisor-writer-2",
        newWriterId: "supervisor-writer-3",
        scope: "malformed expiry must not write",
        expiresAt: "not-a-date",
      }),
    ).rejects.toThrow();
    const reboundMetadata = inspectHarnessProjectMetadata(
      projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    if (reboundMetadata.status !== "valid" || !reboundMetadata.metadata.supervisorNotebook) {
      throw new Error("test rebound metadata must be valid");
    }
    const reboundClaim = reboundMetadata.metadata.supervisorNotebook;
    await expect(
      service.release(
        releaseInput(projectRoot, {
          notebookId: reboundClaim.notebookId,
          location: reboundClaim.location,
          designatedWriterId: "supervisor-writer-1",
        }),
      ),
    ).rejects.toThrow(/writer_conflict/u);
    await service.release(releaseInput(projectRoot, reboundClaim));

    writeFileSync(
      join(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH),
      JSON.stringify({
        supervisorNotebook: {
          notebookId: "nb_bad",
          location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
          designatedWriterId: "supervisor-writer-2",
          scope: "bad",
          expiresAt: "not-a-date",
          establishedAt: "2026-09-07T00:00:00.000Z",
        },
      }),
      "utf8",
    );
    await expect(
      service.prepare({
        agentId: "supervisor-writer-2",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        cwd: projectRoot,
        request: REQUEST,
      }),
    ).rejects.toThrow(/harness_binding_metadata_corrupt/u);
    expect(
      readFileSync(join(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH), "utf8"),
    ).toContain("not-a-date");
  });

  test("uses registered project identity across worktrees and ignores a parent artifact for a nested child", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "harness-binding-service-parent-"));
    tempDirs.push(parentRoot);
    const childRoot = join(parentRoot, "child-project");
    const worktreeA = join(parentRoot, "worktree-a");
    const worktreeB = join(parentRoot, "worktree-b");
    mkdirSync(join(childRoot, "nested"), { recursive: true });
    mkdirSync(join(worktreeA, "nested"), { recursive: true });
    mkdirSync(join(worktreeB, "nested"), { recursive: true });

    const parentClaim = {
      notebookId: "nb_parent_project",
      location: "docs/custom/PARENT.md",
      designatedWriterId: "supervisor-parent",
      scope: "parent scope",
      expiresAt: REQUEST.expiresAt,
      establishedAt: "2026-09-07T00:00:00.000Z",
    };
    const written = writeHarnessProjectMetadata({
      repoRoot: parentRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: { supervisorNotebook: parentClaim },
      expectedRevision: null,
      writerId: parentClaim.designatedWriterId,
    });
    expect(written.ok).toBe(true);

    const workspaces = new Map([
      ["workspace-a", { workspaceId: "workspace-a", projectId: "project-parent", cwd: worktreeA }],
      ["workspace-b", { workspaceId: "workspace-b", projectId: "project-parent", cwd: worktreeB }],
      [
        "workspace-child",
        { workspaceId: "workspace-child", projectId: "project-child", cwd: childRoot },
      ],
    ]);
    const projects = new Map([
      ["project-parent", { projectId: "project-parent", rootPath: parentRoot }],
      ["project-child", { projectId: "project-child", rootPath: childRoot }],
    ]);
    const service = createProjectHarnessBindingService({
      workspaceRegistry: { get: async (id) => (workspaces.get(id) ?? null) as never },
      projectRegistry: {
        get: async (id) => (projects.get(id) ?? null) as never,
        list: async () => Array.from(projects.values()) as never,
      },
    });

    const fromWorktreeA = await service.prepare({
      agentId: "supervisor-parent",
      roleId: "supervisor",
      workspaceId: "workspace-a",
      cwd: join(worktreeA, "nested"),
    });
    const fromWorktreeB = await service.prepare({
      agentId: "supervisor-parent",
      roleId: "supervisor",
      workspaceId: "workspace-b",
      cwd: join(worktreeB, "nested"),
    });
    expect(fromWorktreeA.context.notebook).toEqual(fromWorktreeB.context.notebook);

    const fromChild = await service.prepare({
      agentId: "supervisor-child",
      roleId: "supervisor",
      workspaceId: "workspace-child",
      cwd: join(childRoot, "nested"),
    });
    expect(fromChild.context).toMatchObject({
      projectId: "project-child",
      projectRoot: childRoot,
      cwd: join(childRoot, "nested"),
      notebook: {
        projectScope: "project:project-child",
        reportingTarget: "project:project-child:supervisor-notebook",
        location: DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
        designatedWriterId: null,
      },
    });
    expect(fromChild.context.notebook?.notebookId).not.toBe(
      fromWorktreeA.context.notebook?.notebookId,
    );
  });
});
