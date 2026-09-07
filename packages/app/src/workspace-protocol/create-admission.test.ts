import { describe, expect, test, vi } from "vitest";
import {
  requiresMaterialWorkspaceProtocol,
  requireWorkspaceProtocolForRole,
  WorkspaceProtocolCreateAdmissionError,
} from "./create-admission";

function snapshot(status: "missing" | "valid" | "invalid" | "unreadable") {
  const common = {
    repoRoot: "/repo/worktree",
    path: "/repo/worktree/WORKSPACE_PROTOCOL.md",
    issues: [],
  };
  if (status === "missing") {
    return { status, ...common, suggestedContent: "preview", revision: null } as const;
  }
  if (status === "unreadable") {
    return { status, ...common, revision: null } as const;
  }
  return {
    status,
    ...common,
    content: "protocol",
    revision: { mtimeMs: 1, size: 8, sha256: "a".repeat(64) },
  } as const;
}

const baseInput = {
  serverId: "host-a",
  projectId: "project-a",
  repoRoot: "/repo/worktree",
  roleId: "lead" as const,
  assignment: {
    mutationBoundary: { mode: "bounded-write" as const, scope: "/repo/worktree" },
    externalEffectBoundary: { mode: "denied" as const },
  },
  supported: true,
};

describe("role create Workspace Protocol admission", () => {
  test("treats only material assignment authority as a Workspace Protocol gate", () => {
    expect(
      requiresMaterialWorkspaceProtocol({
        mutationBoundary: { mode: "no-write" },
        externalEffectBoundary: { mode: "denied" },
      }),
    ).toBe(false);
    expect(requiresMaterialWorkspaceProtocol(baseInput.assignment)).toBe(true);
    expect(
      requiresMaterialWorkspaceProtocol({
        mutationBoundary: { mode: "no-write" },
        externalEffectBoundary: { mode: "bounded", scope: "Beads Central" },
      }),
    ).toBe(true);
    expect(
      requiresMaterialWorkspaceProtocol({
        mutationBoundary: { mode: "no-write" },
        externalEffectBoundary: { mode: "denied" },
        notebookGrant: { scope: "append", expiresAt: "2026-09-07T01:00:00.000Z" },
      }),
    ).toBe(true);
  });

  test("permits a read-only role launch when Workspace Protocol is missing or unsupported", async () => {
    const client = { inspectWorkspaceProtocol: vi.fn() };
    await requireWorkspaceProtocolForRole({
      ...baseInput,
      client,
      roleId: "peer",
      assignment: {
        mutationBoundary: { mode: "no-write" },
        externalEffectBoundary: { mode: "denied" },
      },
      supported: false,
    });
    expect(client.inspectWorkspaceProtocol).not.toHaveBeenCalled();
  });

  test("does not inspect an unbound create", async () => {
    const client = { inspectWorkspaceProtocol: vi.fn() };
    await requireWorkspaceProtocolForRole({ ...baseInput, client, roleId: null });
    expect(client.inspectWorkspaceProtocol).not.toHaveBeenCalled();
  });

  test("admits only a valid protocol at the exact workspace root", async () => {
    const status = "valid" as const;
    const client = {
      inspectWorkspaceProtocol: vi.fn(async () => ({
        requestId: "inspect-1",
        ok: true as const,
        snapshot: snapshot(status),
      })),
    };

    await requireWorkspaceProtocolForRole({ ...baseInput, client });
    expect(client.inspectWorkspaceProtocol).toHaveBeenCalledWith("/repo/worktree");
  });

  test.each(["missing", "invalid", "unreadable"] as const)(
    "routes an existing %s protocol to project settings",
    async (status) => {
      const client = {
        inspectWorkspaceProtocol: vi.fn(async () => ({
          requestId: "inspect-1",
          ok: true as const,
          snapshot: snapshot(status),
        })),
      };

      const failure = await requireWorkspaceProtocolForRole({ ...baseInput, client }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(WorkspaceProtocolCreateAdmissionError);
      expect(failure).toMatchObject({
        kind: status,
        projectSettingsRoute:
          "/settings/hosts/host-a/projects/project-a?protocolRoot=%2Frepo%2Fworktree",
      });
    },
  );

  test("fails closed when role admission capability or inspection is unavailable", async () => {
    const client = {
      inspectWorkspaceProtocol: vi.fn(async () => Promise.reject(new Error("down"))),
    };

    await expect(
      requireWorkspaceProtocolForRole({ ...baseInput, client, supported: false }),
    ).rejects.toMatchObject({ kind: "unsupported" });
    expect(client.inspectWorkspaceProtocol).not.toHaveBeenCalled();

    await expect(requireWorkspaceProtocolForRole({ ...baseInput, client })).rejects.toMatchObject({
      kind: "inspection_failed",
    });

    await expect(
      requireWorkspaceProtocolForRole({
        ...baseInput,
        client: {
          inspectWorkspaceProtocol: vi.fn(async () => ({
            requestId: "inspect-1",
            ok: false as const,
            error: { code: "project_not_found" as const },
          })),
        },
      }),
    ).rejects.toMatchObject({ kind: "inspection_failed" });
  });
});
