import { describe, expect, it } from "vitest";
import type { ProjectHarnessInspection } from "@getpaseo/protocol/messages";
import {
  acceptProjectHarnessCommit,
  describeProjectHarnessChange,
  isProjectHarnessPlanConsumed,
  projectHarnessTargetKey,
  resolveProjectHarnessNotebookReleaseSelectors,
  summarizeProjectHarnessInspection,
} from "./project-harness-settings-model";

function inspection(overrides: Partial<ProjectHarnessInspection> = {}): ProjectHarnessInspection {
  return {
    target: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      projectRoot: "/repo",
      workspaceRoot: "/repo",
      cwd: "/repo",
    },
    relationship: { kind: "independent_regular_files" },
    entrypoints: [],
    metadata: {
      path: "/repo/.paseo/project-harness.json",
      status: "valid",
      revision: { status: "regular", mtimeMs: 1, size: 2, sha256: "a".repeat(64) },
    },
    notebook: {
      path: "/repo/.paseo/supervisor.md",
      revision: { status: "regular", mtimeMs: 1, size: 2, sha256: "b".repeat(64) },
      source: "default",
    },
    resources: [],
    workspaceProtocol: {
      path: "/repo/WORKSPACE_PROTOCOL.md",
      revision: { status: "regular", mtimeMs: 1, size: 2, sha256: "c".repeat(64) },
    },
    foreignOwnership: {
      status: "valid",
      manifestPath: "/repo/.paseo/legacy-files.json",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
    },
    instructionVisibility: [],
    recovery: { status: "none", transactionIds: [] },
    provenance: {
      package: "@paseo/harness",
      generation: 1,
      artifactDigest: "d".repeat(64),
      descriptorDigest: "e".repeat(64),
      resources: [],
    },
    ...overrides,
  };
}

describe("project harness settings model", () => {
  it("keeps coverage unknown when the daemon reports no visibility entries", () => {
    expect(summarizeProjectHarnessInspection(inspection()).coverage).toBe("unknown");
  });

  it("surfaces unknown coverage and foreign local deltas without calling them ready", () => {
    const result = summarizeProjectHarnessInspection(
      inspection({
        instructionVisibility: [
          {
            path: "/repo/AGENTS.md",
            scope: "root",
            status: "not_scanned",
            readable: false,
            ownedBy: "unknown",
          },
        ],
        foreignOwnership: {
          status: "valid",
          manifestPath: "/repo/.paseo/legacy-files.json",
          ownedPaths: ["/repo/CLAUDE.md"],
          protectedPaths: [],
          entries: [
            {
              path: "/repo/CLAUDE.md",
              upstreamSha256: "f".repeat(64),
              status: "regular",
              currentSha256: "0".repeat(64),
              drift: "local_delta",
            },
          ],
        },
      }),
    );

    expect(result.coverage).toBe("partial");
    expect(result.instructionUnknownCount).toBe(1);
    expect(result.foreignLocalDeltaCount).toBe(1);
  });

  it("keeps the daemon change action and path together", () => {
    expect(
      describeProjectHarnessChange({
        path: "/repo/CLAUDE.md",
        action: "manual_reconciliation_required",
        before: null,
        after: null,
        reason: "foreign ownership",
      }),
    ).toBe("manual_reconciliation_required: /repo/CLAUDE.md — foreign ownership");
  });

  it("only exposes release selectors when the daemon reports a current writer", () => {
    const withoutWriter = inspection();
    expect(resolveProjectHarnessNotebookReleaseSelectors(withoutWriter)).toBeNull();

    const withWriter = inspection({
      metadata: {
        ...withoutWriter.metadata,
        supervisorNotebook: {
          notebookId: "notebook-1",
          location: "/repo/.paseo/supervisor.md",
          designatedWriterId: "agent-1",
          scope: "project evidence",
          expiresAt: "2026-09-07T23:59:00.000Z",
        },
      },
    });
    expect(resolveProjectHarnessNotebookReleaseSelectors(withWriter)).toMatchObject({
      notebookId: "notebook-1",
      location: "/repo/.paseo/supervisor.md",
      designatedWriterId: "agent-1",
      expectedRevision: withWriter.metadata.revision,
    });
  });

  it("keeps a committed receipt with readback failure and rejects a delayed old target", () => {
    const candidate = {
      targetKey: projectHarnessTargetKey("host-a", "project-1", "workspace-1"),
      receipt: { transactionId: "tx-1" },
      readback: { status: "transport-error" as const, message: "connection closed" },
    };

    expect(acceptProjectHarnessCommit(candidate.targetKey, candidate)).toEqual(candidate);
    expect(
      acceptProjectHarnessCommit(
        projectHarnessTargetKey("host-a", "project-2", "workspace-1"),
        candidate,
      ),
    ).toBeNull();
    expect(isProjectHarnessPlanConsumed(candidate)).toBe(true);
    expect(isProjectHarnessPlanConsumed(null)).toBe(false);
  });
});
