import { describe, expect, it } from "vitest";
import {
  ProjectHarnessApplyResponseSchema,
  ProjectHarnessEntrypointRelationshipSchema,
  ProjectHarnessInspectResponseSchema,
  ProjectHarnessNotebookReleaseRequestSchema,
  ProjectHarnessNotebookReleaseResponseSchema,
  ProjectHarnessPreviewResponseSchema,
  ProjectHarnessUpdateResponseSchema,
} from "./rpc-schemas.js";

describe("Project Harness wire compatibility", () => {
  it("selects relationship branches by their literal kind tag", () => {
    expect(
      ProjectHarnessEntrypointRelationshipSchema.parse({
        kind: "single_regular_file",
        which: "CLAUDE.md",
      }),
    ).toEqual({ kind: "single_regular_file", which: "CLAUDE.md" });
    expect(
      ProjectHarnessEntrypointRelationshipSchema.safeParse({ kind: "future_relationship" }).success,
    ).toBe(false);
  });

  it("keeps every correlated response error branch structurally compatible", () => {
    const error = { code: "feature_unavailable", message: "update the host" };
    for (const [schema, type] of [
      [ProjectHarnessInspectResponseSchema, "foundation.projectHarness.inspect.response"],
      [ProjectHarnessPreviewResponseSchema, "foundation.projectHarness.preview.response"],
      [ProjectHarnessApplyResponseSchema, "foundation.projectHarness.apply.response"],
      [ProjectHarnessUpdateResponseSchema, "foundation.projectHarness.update.response"],
    ] as const) {
      expect(schema.parse({ type, payload: { requestId: "req_1", ok: false, error } })).toEqual({
        type,
        payload: { requestId: "req_1", ok: false, error },
      });
    }
  });

  it("requires release identity and CAS selectors without accepting caller identity", () => {
    const request = {
      type: "foundation.projectHarness.notebook.release.request" as const,
      requestId: "req_release",
      projectId: "prj_1",
      workspaceId: "wks_1",
      notebookId: "nb_1",
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      designatedWriterId: "writer_1",
      expectedRevision: {
        status: "regular" as const,
        mtimeMs: 1,
        size: 2,
        sha256: "a".repeat(64),
      },
    };
    expect(ProjectHarnessNotebookReleaseRequestSchema.parse(request)).toEqual(request);
    expect(
      ProjectHarnessNotebookReleaseRequestSchema.safeParse({ ...request, callerAgentId: "fake" })
        .success,
    ).toBe(false);

    const response = {
      type: "foundation.projectHarness.notebook.release.response" as const,
      payload: {
        requestId: request.requestId,
        ok: true as const,
        result: {
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          notebookId: request.notebookId,
          location: request.location,
          releasedWriterId: request.designatedWriterId,
          metadataRevision: { ...request.expectedRevision, mtimeMs: 3, size: 4 },
          nextStep: "fresh_supervisor_role_first" as const,
        },
      },
    };
    expect(ProjectHarnessNotebookReleaseResponseSchema.parse(response)).toEqual(response);
  });
});
