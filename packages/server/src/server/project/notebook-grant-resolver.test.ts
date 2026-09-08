import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_HARNESS_PROJECT_METADATA_PATH } from "./harness-bootstrap-defaults.js";
import { writeHarnessProjectMetadata } from "./harness-project-metadata-file.js";
import { createNotebookGrantResolver } from "./notebook-grant-resolver.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "notebook-grant-resolver-test-"));
  tempDirs.push(dir);
  return dir;
}

function registries(
  projectRoot: string,
  overrides?: { archivedWorkspace?: boolean; archivedProject?: boolean },
) {
  return {
    workspaceRegistry: {
      get: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        projectId: "project-1",
        cwd: projectRoot,
        archivedAt: overrides?.archivedWorkspace ? "2025-01-01T00:00:00.000Z" : null,
      }),
    },
    projectRegistry: {
      get: vi.fn().mockResolvedValue({
        projectId: "project-1",
        rootPath: projectRoot,
        archivedAt: overrides?.archivedProject ? "2025-01-01T00:00:00.000Z" : null,
      }),
      list: vi.fn().mockResolvedValue([
        {
          projectId: "project-1",
          rootPath: projectRoot,
          archivedAt: overrides?.archivedProject ? "2025-01-01T00:00:00.000Z" : null,
        },
      ]),
    },
  };
}

const REQUEST = { scope: "H3 coordination notes", expiresAt: "2027-01-01T00:00:00.000Z" };

describe("createNotebookGrantResolver", () => {
  test("establishes the first durable claim for a project", async () => {
    const projectRoot = makeProjectRoot();
    const resolve = createNotebookGrantResolver(registries(projectRoot));

    const receipt = await resolve({
      agentId: "supervisor-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      request: REQUEST,
    });

    expect(receipt.effect).toBe("notebook-write");
    expect(receipt.projectId).toBe("project-1");
    expect(receipt.designatedWriterId).toBe("supervisor-1");
    expect(receipt.scope).toBe(REQUEST.scope);
    expect(receipt.expiresAt).toBe(REQUEST.expiresAt);
    expect(receipt.notebookId).toMatch(/^nb_[a-f0-9]{24}$/u);
  });

  test("a resumed request from the SAME agent identity returns the same notebookId and preserves the original establishment", async () => {
    const projectRoot = makeProjectRoot();
    const resolve = createNotebookGrantResolver(registries(projectRoot));

    const first = await resolve({
      agentId: "supervisor-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      request: REQUEST,
    });
    const resumed = await resolve({
      agentId: "supervisor-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      request: REQUEST,
    });

    expect(resumed.notebookId).toBe(first.notebookId);
    expect(resumed.designatedWriterId).toBe("supervisor-1");
  });

  test("a DIFFERENT agent identity requesting the same project's notebook is denied with a conflict, not silently rebound", async () => {
    const projectRoot = makeProjectRoot();
    const resolve = createNotebookGrantResolver(registries(projectRoot));

    await resolve({
      agentId: "supervisor-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      request: REQUEST,
    });

    await expect(
      resolve({
        agentId: "supervisor-2",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_writer_conflict/u);
  });

  test("rejects a non-Supervisor role outright", async () => {
    const projectRoot = makeProjectRoot();
    const resolve = createNotebookGrantResolver(registries(projectRoot));

    await expect(
      resolve({
        agentId: "peer-1",
        roleId: "peer",
        workspaceId: "workspace-1",
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_requires_supervisor_role/u);
  });

  test("fails closed when the workspace is unavailable or archived", async () => {
    const projectRoot = makeProjectRoot();
    const resolve = createNotebookGrantResolver(
      registries(projectRoot, { archivedWorkspace: true }),
    );

    await expect(
      resolve({
        agentId: "supervisor-1",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_workspace_unavailable/u);
  });

  test("fails closed when the project is unavailable or archived", async () => {
    const projectRoot = makeProjectRoot();
    const resolve = createNotebookGrantResolver(registries(projectRoot, { archivedProject: true }));

    await expect(
      resolve({
        agentId: "supervisor-1",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_project_unavailable/u);
  });

  test("fails closed when the durable project metadata file is corrupt rather than guessing at intent", async () => {
    const projectRoot = makeProjectRoot();
    const written = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: {},
      expectedRevision: null,
      writerId: "supervisor-1",
    });
    expect(written.ok).toBe(true);
    // Corrupt the file directly on disk (bypassing the CAS writer) so the
    // resolver must observe genuinely unparsable content, not a fixture lie.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH), "{not json", "utf8");

    const resolve = createNotebookGrantResolver(registries(projectRoot));
    await expect(
      resolve({
        agentId: "supervisor-1",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_metadata_corrupt/u);
  });

  test("fails closed when the metadata file parses as JSON but the wrong shape (array, not an object)", async () => {
    const projectRoot = makeProjectRoot();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname, join: pathJoin } = await import("node:path");
    const metadataPath = pathJoin(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, "[]", "utf8");

    const resolve = createNotebookGrantResolver(registries(projectRoot));
    await expect(
      resolve({
        agentId: "supervisor-1",
        roleId: "supervisor",
        workspaceId: "workspace-1",
        request: REQUEST,
      }),
    ).rejects.toThrow(/notebook_grant_metadata_corrupt/u);
  });

  test("reuses an existing authorized custom notebook location without overwriting its identity", async () => {
    const projectRoot = makeProjectRoot();
    const written = writeHarnessProjectMetadata({
      repoRoot: projectRoot,
      relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      metadata: {
        supervisorNotebook: {
          notebookId: "nb_foreign_or_custom_location",
          location: "docs/some-other-location.md",
          designatedWriterId: "supervisor-1",
          scope: "some other scope",
          expiresAt: REQUEST.expiresAt,
          establishedAt: new Date().toISOString(),
        },
      },
      expectedRevision: null,
      writerId: "supervisor-1",
    });
    expect(written.ok).toBe(true);

    const resolve = createNotebookGrantResolver(registries(projectRoot));
    const receipt = await resolve({
      agentId: "supervisor-1",
      roleId: "supervisor",
      workspaceId: "workspace-1",
      request: REQUEST,
    });
    expect(receipt.notebookId).toBe("nb_foreign_or_custom_location");
    expect(receipt.location).toBe("docs/some-other-location.md");

    // The pre-existing claim must be completely untouched by the rejected attempt.
    const after = await import("./harness-project-metadata-file.js").then((module) =>
      module.inspectHarnessProjectMetadata(projectRoot, DEFAULT_HARNESS_PROJECT_METADATA_PATH),
    );
    expect(after.status).toBe("valid");
    expect(after.status === "valid" ? after.metadata.supervisorNotebook?.notebookId : null).toBe(
      "nb_foreign_or_custom_location",
    );
  });
});
