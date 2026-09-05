import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  addRunOptions,
  buildCliAssignment,
  buildCliNotebookGrantRequest,
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("CLI assignment issue grants", () => {
  it("normalizes exact Peer issue grants into the immutable envelope", () => {
    expect(
      buildCliAssignment({
        roleId: "peer",
        effectClass: "mutating",
        objective: "Implement the granted issue",
        cwd: "/repo",
        beadsIssueIds: [" ps123-abc ", "ps123-abc"],
      }),
    ).toMatchObject({
      resourceGrants: { beadsIssueIds: ["ps123-abc"] },
      externalEffectBoundary: {
        mode: "bounded",
        scope: "Beads Central issue/work graph for this assignment only; no other external effects",
      },
    });
  });

  it("parses repeatable external access grants and derives their bounded scope", () => {
    const command = addRunOptions(new Command());
    command.parse(
      [
        "--role",
        "peer",
        "--assignment-effect",
        "mutating",
        "--external-effect",
        "read dev database",
        "--external-effect",
        "write sandbox API",
        "implement task",
      ],
      { from: "user" },
    );
    const options = command.opts<AgentRunOptions>();

    expect(options.externalEffect).toEqual(["read dev database", "write sandbox API"]);
    expect(
      buildCliAssignment({
        roleId: "peer",
        effectClass: "mutating",
        objective: "Implement task",
        cwd: "/repo",
        beadsIssueIds: ["ps123-abc"],
        externalEffects: options.externalEffect,
      }),
    ).toMatchObject({
      resourceGrants: {
        beadsIssueIds: ["ps123-abc"],
        externalEffects: ["read dev database", "write sandbox API"],
      },
      externalEffectBoundary: {
        mode: "bounded",
        scope:
          "Beads Central issue/work graph for this assignment only; plus Human-leased external access: read dev database; write sandbox API",
      },
    });
  });
});

describe("CLI Supervisor notebook grant request", () => {
  const now = new Date("2026-09-07T00:00:00.000Z");
  const expiresAt = "2026-09-07T01:00:00.000Z";

  it("accepts only scope and expiry and keeps daemon identities out of the request", () => {
    const request = buildCliNotebookGrantRequest({
      roleId: "supervisor",
      scope: " append evidence ",
      expiresAt,
      now,
    });
    expect(request).toEqual({ scope: "append evidence", expiresAt });
    expect(request).not.toHaveProperty("notebookId");
    expect(request).not.toHaveProperty("location");
    expect(request).not.toHaveProperty("designatedWriterId");
  });

  it("adds the grant request without widening provider or external boundaries", () => {
    const notebookGrant = buildCliNotebookGrantRequest({
      roleId: "supervisor",
      scope: "append evidence",
      expiresAt,
      now,
    });
    expect(
      buildCliAssignment({
        roleId: "supervisor",
        effectClass: "read-only",
        objective: "Observe and report",
        cwd: "/repo",
        notebookGrant,
      }),
    ).toMatchObject({
      mutationBoundary: { mode: "no-write" },
      externalEffectBoundary: { mode: "denied" },
      notebookGrant: { scope: "append evidence", expiresAt },
    });
  });

  it("rejects grants for non-Supervisor roles", () => {
    expect(() =>
      buildCliNotebookGrantRequest({
        roleId: "peer",
        scope: "append evidence",
        expiresAt,
        now,
      }),
    ).toThrowError(/require --role supervisor/);
  });

  it("rejects incomplete, expired, and malformed requests", () => {
    expect(() =>
      buildCliNotebookGrantRequest({ roleId: "supervisor", scope: "append evidence", now }),
    ).toThrowError(/must be provided together/);
    expect(() =>
      buildCliNotebookGrantRequest({
        roleId: "supervisor",
        scope: "append evidence",
        expiresAt: "2026-09-06T23:00:00.000Z",
        now,
      }),
    ).toThrowError(/must be in the future/);
    expect(() =>
      buildCliNotebookGrantRequest({
        roleId: "supervisor",
        scope: "append evidence",
        expiresAt: "not-a-timestamp",
        now,
      }),
    ).toThrowError(/Invalid Supervisor notebook grant request/);
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { newWorkspace: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });

  it("rejects an unknown Paseo role before connecting", async () => {
    await expectInvalidOptions({ role: "architect" }, /Unsupported Paseo role/);
  });

  it("requires an explicit assignment effect for a role", async () => {
    await expectInvalidOptions({ role: "lead" }, /--assignment-effect is required with --role/);
  });

  it("rejects write scope for a no-write effect", async () => {
    await expectInvalidOptions(
      { role: "lead", assignmentEffect: "read-only", writeScope: "src/**" },
      /--write-scope is not allowed for read-only/,
    );
  });

  it("rejects external access grants when the role effect is externally denied", async () => {
    await expectInvalidOptions(
      {
        role: "peer",
        assignmentEffect: "read-only",
        externalEffect: ["read dev database"],
      },
      /--external-effect is not allowed for peer read-only/,
    );
  });

  it("allows a read-only Peer without a grant and requires one for mutation", async () => {
    await expect(
      runRunCommand(
        "inspect current bytes",
        { role: "peer", assignmentEffect: "read-only", json: true },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
    await expectInvalidOptions(
      { role: "peer", assignmentEffect: "mutating" },
      /--beads-issue is required with --role peer --assignment-effect mutating/,
    );
  });

  it("rejects Peer issue grants on another role", async () => {
    await expectInvalidOptions(
      { role: "lead", assignmentEffect: "read-only", beadsIssue: ["ps123-abc"] },
      /--beads-issue is only valid with --role peer/,
    );
  });

  it("validates notebook grant flags before connecting to a daemon", async () => {
    await expectInvalidOptions(
      { notebookGrantScope: "append evidence" },
      /require --role supervisor/,
    );
    await expectInvalidOptions(
      {
        role: "supervisor",
        assignmentEffect: "read-only",
        notebookGrantScope: "append evidence",
      },
      /must be provided together/,
    );
    await expectInvalidOptions(
      {
        role: "supervisor",
        assignmentEffect: "read-only",
        notebookGrantScope: "append evidence",
        notebookGrantExpiresAt: "2020-01-01T00:00:00.000Z",
      },
      /must be in the future/,
    );
  });
});
