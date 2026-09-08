import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HARNESS_PROJECT_METADATA_PATH } from "../../project/harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  writeHarnessProjectMetadata,
} from "../../project/harness-project-metadata-file.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function expectCorrelatedError(payload: unknown, requestId: string, code: string): void {
  expect(payload).toMatchObject({
    requestId,
    ok: false,
    error: { code },
  });
}

describe("Project Harness public transport", () => {
  it("round-trips all five operations through the public daemon WebSocket", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "paseo-project-harness-transport-"));
    fixtureRoots.push(projectRoot);
    const workspaceProtocolPath = join(projectRoot, "WORKSPACE_PROTOCOL.md");
    const workspaceProtocolContent = "# Workspace Protocol\n";
    await writeFile(workspaceProtocolPath, workspaceProtocolContent);

    const daemon = await createTestPaseoDaemon();
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.7.0-paseo.58",
    });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "project-harness-transport" } });

      const projectResponse = await client.addProject(projectRoot, "transport-project");
      expect(projectResponse.error).toBeNull();
      const project = projectResponse.project;
      if (!project) throw new Error("Project registration did not return a project");

      const workspaceResponse = await client.createWorkspace({
        source: { kind: "directory", path: projectRoot, projectId: project.projectId },
      });
      expect(workspaceResponse.error).toBeNull();
      const workspace = workspaceResponse.workspace;
      if (!workspace) throw new Error("Workspace registration did not return a workspace");

      const target = {
        projectId: project.projectId,
        workspaceId: workspace.id,
        cwd: projectRoot,
      };

      const inspectResponse = await client.inspectProjectHarness({
        ...target,
        requestId: "transport-inspect-success",
      });
      expect(inspectResponse).toMatchObject({
        requestId: "transport-inspect-success",
        ok: true,
        inspection: { target },
      });

      const inspectError = await client.inspectProjectHarness({
        ...target,
        workspaceId: "wks_missing_for_transport_error",
        requestId: "transport-inspect-error",
      });
      expectCorrelatedError(
        inspectError,
        "transport-inspect-error",
        "harness_project_workspace_unavailable",
      );

      await rm(workspaceProtocolPath);
      const previewError = await client.previewProjectHarness({
        ...target,
        operation: "bootstrap",
        requestId: "transport-preview-error",
      });
      expectCorrelatedError(previewError, "transport-preview-error", "workspace_protocol_required");
      await writeFile(workspaceProtocolPath, workspaceProtocolContent);

      const bootstrapPreview = await client.previewProjectHarness({
        ...target,
        operation: "bootstrap",
        requestId: "transport-preview-success",
      });
      expect(bootstrapPreview).toMatchObject({
        requestId: "transport-preview-success",
        ok: true,
        plan: { operation: "bootstrap", target },
        readyToApply: true,
      });
      if (!bootstrapPreview.ok) throw new Error(bootstrapPreview.error.code);

      await writeFile(workspaceProtocolPath, "# changed after preview\n");
      const applyError = await client.applyProjectHarness({
        ...target,
        plan: bootstrapPreview.plan,
        requestId: "transport-apply-error",
      });
      expectCorrelatedError(applyError, "transport-apply-error", "stale_plan");
      await writeFile(workspaceProtocolPath, workspaceProtocolContent);

      const freshBootstrapPreview = await client.previewProjectHarness({
        ...target,
        operation: "bootstrap",
        requestId: "transport-preview-bootstrap-fresh",
      });
      expect(freshBootstrapPreview.ok).toBe(true);
      if (!freshBootstrapPreview.ok) throw new Error(freshBootstrapPreview.error.code);

      const applyResponse = await client.applyProjectHarness({
        ...target,
        plan: freshBootstrapPreview.plan,
        requestId: "transport-apply-success",
      });
      expect(applyResponse).toMatchObject({
        requestId: "transport-apply-success",
        ok: true,
        result: { operation: "bootstrap", inspection: { target } },
      });

      const updatePreview = await client.previewProjectHarness({
        ...target,
        operation: "update",
        requestId: "transport-preview-update-error",
      });
      expect(updatePreview.ok).toBe(true);
      if (!updatePreview.ok) throw new Error(updatePreview.error.code);

      await writeFile(workspaceProtocolPath, "# changed before update\n");
      const updateError = await client.updateProjectHarness({
        ...target,
        plan: updatePreview.plan,
        requestId: "transport-update-error",
      });
      expectCorrelatedError(updateError, "transport-update-error", "stale_plan");
      await writeFile(workspaceProtocolPath, workspaceProtocolContent);

      const freshUpdatePreview = await client.previewProjectHarness({
        ...target,
        operation: "update",
        requestId: "transport-preview-update-success",
      });
      expect(freshUpdatePreview.ok).toBe(true);
      if (!freshUpdatePreview.ok) throw new Error(freshUpdatePreview.error.code);

      const updateResponse = await client.updateProjectHarness({
        ...target,
        plan: freshUpdatePreview.plan,
        requestId: "transport-update-success",
      });
      expect(updateResponse).toMatchObject({
        requestId: "transport-update-success",
        ok: true,
        result: { operation: "update", inspection: { target } },
      });

      const metadata = inspectHarnessProjectMetadata(
        projectRoot,
        DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      );
      if (metadata.status !== "valid") {
        throw new Error("Bootstrap did not produce valid Project Harness metadata");
      }
      const claim = {
        notebookId: "nb_transport_release",
        location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
        designatedWriterId: "writer_transport_release",
        scope: "public transport regression",
        expiresAt: "2099-01-01T00:00:00.000Z",
        establishedAt: "2026-09-08T00:00:00.000Z",
      };
      const claimWrite = writeHarnessProjectMetadata({
        repoRoot: projectRoot,
        relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
        metadata: {
          ...metadata.metadata,
          supervisorNotebookIdentity: {
            notebookId: claim.notebookId,
            location: claim.location,
          },
          supervisorNotebook: claim,
        },
        expectedRevision: metadata.revision,
        writerId: claim.designatedWriterId,
      });
      if (!claimWrite.ok) throw new Error("Failed to seed the isolated notebook claim");

      const getAgent = vi
        .spyOn(daemon.daemon.agentManager, "getAgent")
        .mockReturnValue({ id: claim.designatedWriterId, lifecycle: "idle" } as never);
      try {
        const releaseResponse = await client.releaseProjectHarnessNotebook({
          ...target,
          notebookId: claim.notebookId,
          location: claim.location,
          designatedWriterId: claim.designatedWriterId,
          expectedRevision: { status: "regular", ...claimWrite.snapshot.revision },
          requestId: "transport-notebook-release-success",
        });
        expect(releaseResponse).toMatchObject({
          requestId: "transport-notebook-release-success",
          ok: true,
          result: {
            projectId: project.projectId,
            workspaceId: workspace.id,
            notebookId: claim.notebookId,
            location: claim.location,
            releasedWriterId: claim.designatedWriterId,
            nextStep: "fresh_supervisor_role_first",
          },
        });
        if (!releaseResponse.ok) throw new Error(releaseResponse.error.code);

        const releaseError = await client.releaseProjectHarnessNotebook({
          ...target,
          notebookId: claim.notebookId,
          location: claim.location,
          designatedWriterId: claim.designatedWriterId,
          expectedRevision: releaseResponse.result.metadataRevision,
          requestId: "transport-notebook-release-error",
        });
        expectCorrelatedError(
          releaseError,
          "transport-notebook-release-error",
          "notebook_release_claim_missing",
        );
      } finally {
        getAgent.mockRestore();
      }
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
    }
  }, 180000);
});
