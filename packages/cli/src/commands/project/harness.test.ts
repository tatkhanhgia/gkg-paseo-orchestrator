import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ProjectHarnessInspection,
  ProjectHarnessMutationResult,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectCommand } from "./index.js";
import { readProjectHarnessPlan, readProjectHarnessRevision, resolveOperation } from "./harness.js";

const daemon = vi.hoisted(() => ({
  inspectProjectHarness: vi.fn(),
  previewProjectHarness: vi.fn(),
  applyProjectHarness: vi.fn(),
  updateProjectHarness: vi.fn(),
  releaseProjectHarnessNotebook: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  buildDaemonConnectionCommandError: vi.fn(({ error }: { error: unknown }) => error),
  connectToDaemon: vi.fn(async () => daemon),
}));

const plan = {
  operation: "bootstrap" as const,
  target: {
    projectId: "project-1",
    workspaceId: "workspace-1",
    projectRoot: "/repo",
    workspaceRoot: "/repo",
    cwd: "/repo",
  },
  provenance: {
    package: "@paseo/harness",
    generation: 1,
    artifactDigest: "a".repeat(64),
    descriptorDigest: "b".repeat(64),
    resources: [],
  },
  guards: [],
  files: [],
  planDigest: "c".repeat(64),
};

const inspection: ProjectHarnessInspection = {
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
};

const mutationResult: ProjectHarnessMutationResult = {
  operation: "bootstrap",
  transactionId: "transaction-1",
  changedPaths: ["CLAUDE.md"],
  inspection,
  recovery: { status: "none", transactionIds: [] },
};

function captureOutput() {
  let exitCode: number | undefined;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
  }) as never);
  return { stdout, stderr, exit, getExitCode: () => exitCode };
}

async function runProjectCommand(args: string[]) {
  await createProjectCommand().parseAsync(["node", "project", ...args]);
}

function outputText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  daemon.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project harness CLI helpers", () => {
  it("accepts only the two pinned daemon operations", () => {
    expect(resolveOperation("bootstrap")).toBe("bootstrap");
    expect(resolveOperation("update")).toBe("update");
    expect(() => resolveOperation("release")).toThrow();
  });

  it("reads either a raw guarded plan or the JSON preview envelope", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-harness-cli-"));
    try {
      const rawPath = path.join(directory, "plan.json");
      writeFileSync(rawPath, JSON.stringify(plan));
      expect(readProjectHarnessPlan(rawPath)).toEqual(plan);

      const previewPath = path.join(directory, "preview.json");
      writeFileSync(previewPath, JSON.stringify({ ok: true, plan }));
      expect(readProjectHarnessPlan(previewPath)).toEqual(plan);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads a current metadata revision from raw or inspect JSON", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-harness-revision-"));
    const revision = { status: "regular", mtimeMs: 1, size: 2, sha256: "d".repeat(64) } as const;
    try {
      const rawPath = path.join(directory, "revision.json");
      writeFileSync(rawPath, JSON.stringify(revision));
      expect(readProjectHarnessRevision(rawPath)).toEqual(revision);

      const inspectPath = path.join(directory, "inspect.json");
      writeFileSync(
        inspectPath,
        JSON.stringify({ ok: true, inspection: { metadata: { revision } } }),
      );
      expect(readProjectHarnessRevision(inspectPath)).toEqual(revision);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders positive inspect and preview JSON that can be saved for the next command", async () => {
    const output = captureOutput();
    daemon.inspectProjectHarness.mockResolvedValueOnce({
      requestId: "inspect-1",
      ok: true,
      inspection,
    });
    await runProjectCommand([
      "harness",
      "inspect",
      "project-1",
      "--workspace",
      "workspace-1",
      "--json",
    ]);
    const inspectJson = outputText(output.stdout);
    expect(JSON.parse(inspectJson)).toMatchObject({ ok: true, inspection });

    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-harness-roundtrip-"));
    try {
      const inspectPath = path.join(directory, "inspect.json");
      writeFileSync(inspectPath, inspectJson);
      expect(readProjectHarnessRevision(inspectPath)).toEqual(inspection.metadata.revision);

      daemon.previewProjectHarness.mockResolvedValueOnce({
        requestId: "preview-1",
        ok: true,
        inspection,
        plan,
        changes: [],
        readyToApply: true,
      });
      await runProjectCommand([
        "harness",
        "preview",
        "project-1",
        "bootstrap",
        "--workspace",
        "workspace-1",
        "--json",
      ]);
      const previewPath = path.join(directory, "preview.json");
      writeFileSync(previewPath, outputText(output.stdout).slice(inspectJson.length));
      expect(readProjectHarnessPlan(previewPath)).toEqual(plan);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(output.getExitCode()).toBeUndefined();
    expect(output.stderr).not.toHaveBeenCalled();
  });

  it("turns an inspect RPC error into exit 1 structured stderr without stdout", async () => {
    const output = captureOutput();
    const rpcError = {
      code: "PROJECT_HARNESS_STALE",
      message: "The metadata revision is stale",
      paths: [".paseo/project-harness.json"],
      recovery: { status: "blocked" as const, transactionIds: ["transaction-0"] },
    };
    daemon.inspectProjectHarness.mockResolvedValueOnce({
      requestId: "inspect-1",
      ok: false,
      error: rpcError,
    });

    await runProjectCommand([
      "harness",
      "inspect",
      "project-1",
      "--workspace",
      "workspace-1",
      "--json",
    ]);

    const rendered = JSON.parse(outputText(output.stderr)) as {
      error: { code: string; details: { rpc: typeof rpcError } };
    };
    expect(output.getExitCode()).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(rendered.error.code).toBe(rpcError.code);
    expect(rendered.error.details.rpc).toEqual(rpcError);
  });

  it("preserves the release and fresh inspect request ids in positive JSON output", async () => {
    const output = captureOutput();
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-harness-release-success-"));
    const releaseResult = {
      projectId: "project-1",
      workspaceId: "workspace-1",
      notebookId: "notebook-1",
      location: "/repo/.paseo/supervisor.md",
      releasedWriterId: "agent-1",
      metadataRevision: inspection.metadata.revision,
      nextStep: "fresh_supervisor_role_first" as const,
    };
    try {
      const revisionPath = path.join(directory, "revision.json");
      writeFileSync(revisionPath, JSON.stringify(inspection.metadata.revision));
      daemon.releaseProjectHarnessNotebook.mockResolvedValueOnce({
        requestId: "release-1",
        ok: true,
        result: releaseResult,
      });
      daemon.inspectProjectHarness.mockResolvedValueOnce({
        requestId: "inspect-after-release-1",
        ok: true,
        inspection,
      });

      await runProjectCommand([
        "harness",
        "release",
        "project-1",
        "--workspace",
        "workspace-1",
        "--notebook-id",
        "notebook-1",
        "--location",
        "/repo/.paseo/supervisor.md",
        "--designated-writer-id",
        "agent-1",
        "--expected-revision-file",
        revisionPath,
        "--json",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const rendered = JSON.parse(outputText(output.stdout)) as {
      release: { requestId: string; ok: boolean; result: typeof releaseResult };
      freshInspection: { requestId: string; ok: boolean; inspection: ProjectHarnessInspection };
    };
    expect(output.getExitCode()).toBeUndefined();
    expect(output.stderr).not.toHaveBeenCalled();
    expect(rendered.release).toMatchObject({ requestId: "release-1", ok: true });
    expect(rendered.release.result).toEqual(releaseResult);
    expect(rendered.freshInspection).toMatchObject({
      requestId: "inspect-after-release-1",
      ok: true,
      inspection,
    });
    expect(rendered.freshInspection.requestId).not.toBe(rendered.release.requestId);
    expect(daemon.releaseProjectHarnessNotebook).toHaveBeenCalledWith({
      projectId: "project-1",
      workspaceId: "workspace-1",
      notebookId: "notebook-1",
      location: "/repo/.paseo/supervisor.md",
      designatedWriterId: "agent-1",
      expectedRevision: inspection.metadata.revision,
    });
    expect(daemon.inspectProjectHarness).toHaveBeenCalledWith({
      projectId: "project-1",
      workspaceId: "workspace-1",
    });
  });

  it("keeps an applied receipt when post-commit RPC readback fails", async () => {
    const output = captureOutput();
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-harness-apply-"));
    try {
      const planPath = path.join(directory, "plan.json");
      writeFileSync(planPath, JSON.stringify(plan));
      daemon.applyProjectHarness.mockResolvedValueOnce({
        requestId: "apply-1",
        ok: true,
        result: mutationResult,
      });
      daemon.inspectProjectHarness.mockResolvedValueOnce({
        requestId: "inspect-2",
        ok: false,
        error: { code: "READBACK_UNAVAILABLE", message: "inspection unavailable" },
      });

      await runProjectCommand([
        "harness",
        "apply",
        "project-1",
        "--workspace",
        "workspace-1",
        "--plan-file",
        planPath,
        "--json",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const rendered = JSON.parse(outputText(output.stderr)) as {
      error: {
        code: string;
        message: string;
        details: {
          completed: ProjectHarnessMutationResult;
          readback: { kind: string; rpc: { code: string } };
        };
      };
    };
    expect(output.getExitCode()).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(rendered.error.code).toBe("PROJECT_HARNESS_APPLY_READBACK_FAILED");
    expect(rendered.error.message).toContain("inspect or reload");
    expect(rendered.error.details.completed).toEqual(mutationResult);
    expect(rendered.error.details.readback).toMatchObject({
      kind: "rpc",
      rpc: { code: "READBACK_UNAVAILABLE" },
    });
  });

  it("keeps a released receipt when post-commit transport readback fails", async () => {
    const output = captureOutput();
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-harness-release-"));
    const releaseResult = {
      projectId: "project-1",
      workspaceId: "workspace-1",
      notebookId: "notebook-1",
      location: "/repo/.paseo/supervisor.md",
      releasedWriterId: "agent-1",
      metadataRevision: inspection.metadata.revision,
      nextStep: "fresh_supervisor_role_first" as const,
    };
    try {
      const revisionPath = path.join(directory, "revision.json");
      writeFileSync(revisionPath, JSON.stringify(inspection.metadata.revision));
      daemon.releaseProjectHarnessNotebook.mockResolvedValueOnce({
        requestId: "release-1",
        ok: true,
        result: releaseResult,
      });
      daemon.inspectProjectHarness.mockRejectedValueOnce(new Error("socket closed"));

      await runProjectCommand([
        "harness",
        "release",
        "project-1",
        "--workspace",
        "workspace-1",
        "--notebook-id",
        "notebook-1",
        "--location",
        "/repo/.paseo/supervisor.md",
        "--designated-writer-id",
        "agent-1",
        "--expected-revision-file",
        revisionPath,
        "--json",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const rendered = JSON.parse(outputText(output.stderr)) as {
      error: {
        details: {
          completed: typeof releaseResult;
          readback: { kind: string; error: { message: string } };
        };
      };
    };
    expect(output.getExitCode()).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(rendered.error.details.completed).toEqual(releaseResult);
    expect(rendered.error.details.readback).toEqual({
      kind: "transport",
      error: expect.objectContaining({ message: "socket closed" }),
    });
  });
});
