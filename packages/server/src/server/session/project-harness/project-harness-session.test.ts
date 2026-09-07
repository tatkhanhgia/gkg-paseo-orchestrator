import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import {
  ProjectHarnessServiceError,
  type ProjectHarnessService,
} from "../../project/project-harness-service.js";
import { createProjectHarnessService } from "../../project/project-harness-service.js";
import { createProjectHarnessBindingService } from "../../project/harness-binding-service.js";
import { DEFAULT_HARNESS_PROJECT_METADATA_PATH } from "../../project/harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  writeHarnessProjectMetadata,
} from "../../project/harness-project-metadata-file.js";
import {
  applyProjectHarnessFileTransaction,
  inspectProjectHarnessFile,
  inspectProjectHarnessTransactions,
} from "../../../utils/project-harness-file-transaction.js";
import { ProjectHarnessSession } from "./project-harness-session.js";

const instructionFixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    instructionFixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const target = {
  projectId: "prj_session_test",
  workspaceId: "wks_session_test",
  projectRoot: "/tmp/project-harness-session",
  workspaceRoot: "/tmp/project-harness-session",
  cwd: "/tmp/project-harness-session",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function makeReleaseFixture(
  options: {
    testing?: { beforeFirstRename?: () => void | Promise<void> };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "paseo-project-harness-release-race-"));
  instructionFixtureRoots.push(root);
  const projectId = "prj_release_race";
  const workspaceId = "wks_release_race";
  const writerId = "writer-release-race";
  const claim = {
    notebookId: "nb_release_race",
    location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
    designatedWriterId: writerId,
    scope: "bounded release race proof",
    expiresAt: "2027-01-01T00:00:00.000Z",
    establishedAt: "2026-09-07T00:00:00.000Z",
  };
  const written = writeHarnessProjectMetadata({
    repoRoot: root,
    relativePath: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    metadata: { supervisorNotebook: claim },
    expectedRevision: null,
    writerId,
  });
  if (!written.ok) throw new Error("release race fixture metadata write failed");
  const metadata = inspectHarnessProjectMetadata(root, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
  if (metadata.status !== "valid") throw new Error("release race fixture metadata is not valid");
  const project = { projectId, rootPath: root, archivedAt: null };
  const workspace = { workspaceId, projectId, cwd: root, archivedAt: null };
  const resolver = createProjectHarnessBindingService({
    workspaceRegistry: { get: async () => workspace as never },
    projectRegistry: {
      get: async (requestedProjectId) =>
        requestedProjectId === projectId ? (project as never) : null,
      list: async () => [project] as never,
    },
    testing: options.testing,
  });
  return {
    root,
    projectId,
    workspaceId,
    writerId,
    claim,
    expectedRevision: { status: "regular" as const, ...metadata.revision },
    target: {
      projectId,
      workspaceId,
      projectRoot: root,
      workspaceRoot: root,
      cwd: root,
    },
    request: {
      type: "foundation.projectHarness.notebook.release.request" as const,
      requestId: "release-race-request",
      projectId,
      workspaceId,
      cwd: root,
      notebookId: claim.notebookId,
      location: claim.location,
      designatedWriterId: writerId,
      expectedRevision: { status: "regular" as const, ...metadata.revision },
    },
    resolver,
  };
}

describe("ProjectHarnessSession", () => {
  it("returns bounded root and local instruction visibility through native inspect RPC", async () => {
    const fixtureParent = await mkdtemp(join(tmpdir(), "paseo-project-harness-instruction-rpc-"));
    const root = join(fixtureParent, "project");
    instructionFixtureRoots.push(fixtureParent);
    await mkdir(root);
    await writeFile(join(root, "WORKSPACE_PROTOCOL.md"), "# Workspace Protocol\n");
    await writeFile(join(fixtureParent, "CLAUDE.local.md"), "ancestor local instructions\n");
    await writeFile(join(root, "AGENTS.override.md"), "root agents additional instructions\n");
    await symlink("AGENTS.override.md", join(root, "CLAUDE.override.md"));
    await writeFile(join(root, "CLAUDE.local.md"), "root local instructions\n");
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude", "CLAUDE.md"), "project Claude instructions\n");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "CLAUDE.local.md"), "nested local instructions\n");

    const rpcTarget = {
      ...target,
      projectRoot: root,
      workspaceRoot: root,
      cwd: root,
    };
    const emitted: SessionOutboundMessage[] = [];
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: {
        resolveProjectHarnessTarget: vi.fn().mockResolvedValue(rpcTarget),
      } as never,
      service: createProjectHarnessService(),
      logger: pino({ level: "silent" }),
    });

    const inspect = (requestId: string) => ({
      type: "foundation.projectHarness.inspect.request" as const,
      requestId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
    });
    await session.handleInspectRequest(inspect("instruction-visibility-1"));
    const firstResponse = emitted[0];
    if (!firstResponse || firstResponse.type !== "foundation.projectHarness.inspect.response") {
      throw new Error("native inspect response missing");
    }
    if (!firstResponse.payload.ok) throw new Error("native inspect unexpectedly failed");
    const firstVisibility = new Map(
      firstResponse.payload.inspection.instructionVisibility.map((entry) => [entry.path, entry]),
    );
    expect(firstVisibility.get(join(root, "AGENTS.override.md"))).toMatchObject({
      scope: "override",
      status: "regular",
      readable: true,
      ownedBy: "unknown",
    });
    expect(firstVisibility.get(join(root, "CLAUDE.override.md"))).toMatchObject({
      scope: "override",
      status: "symlink",
      readable: true,
      ownedBy: "unknown",
    });
    expect(firstVisibility.get(join(root, "CLAUDE.local.md"))).toMatchObject({
      scope: "root",
      status: "regular",
      readable: true,
      ownedBy: "unknown",
    });
    expect(firstVisibility.get(join(fixtureParent, "CLAUDE.local.md"))).toMatchObject({
      scope: "ancestor",
      status: "regular",
      readable: true,
      ownedBy: "outside-project",
    });
    expect(firstVisibility.get(join(root, ".claude", "CLAUDE.md"))).toMatchObject({
      scope: "nested",
      status: "regular",
      readable: true,
      ownedBy: "unknown",
    });
    expect(firstVisibility.get(join(root, "nested", "CLAUDE.local.md"))).toMatchObject({
      scope: "nested",
      status: "regular",
      readable: true,
      ownedBy: "unknown",
    });
    await expect(readlink(join(root, "CLAUDE.override.md"))).resolves.toBe("AGENTS.override.md");

    await rm(join(root, "AGENTS.override.md"));
    await rm(join(root, "CLAUDE.override.md"));
    await mkdir(join(root, "CLAUDE.override.md"));
    await rm(join(root, "CLAUDE.local.md"));
    emitted.length = 0;
    await session.handleInspectRequest(inspect("instruction-visibility-2"));
    const secondResponse = emitted[0];
    if (!secondResponse || secondResponse.type !== "foundation.projectHarness.inspect.response") {
      throw new Error("native second inspect response missing");
    }
    if (!secondResponse.payload.ok) throw new Error("native second inspect unexpectedly failed");
    const secondVisibility = new Map(
      secondResponse.payload.inspection.instructionVisibility.map((entry) => [entry.path, entry]),
    );
    expect(secondVisibility.get(join(root, "AGENTS.override.md"))).toMatchObject({
      status: "missing",
      readable: false,
      ownedBy: "unknown",
    });
    expect(secondVisibility.get(join(root, "CLAUDE.override.md"))).toMatchObject({
      status: "unreadable",
      readable: false,
      ownedBy: "unknown",
    });
    expect(secondVisibility.get(join(root, "CLAUDE.local.md"))).toMatchObject({
      status: "missing",
      readable: false,
      ownedBy: "unknown",
    });
    await expect(readFile(join(root, ".claude", "CLAUDE.md"), "utf8")).resolves.toBe(
      "project Claude instructions\n",
    );
    await expect(readFile(join(root, "nested", "CLAUDE.local.md"), "utf8")).resolves.toBe(
      "nested local instructions\n",
    );
    await expect(readdir(join(root, "CLAUDE.override.md"))).resolves.toEqual([]);
  });

  it("resolves the registered target before dispatching an inspect RPC", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const resolveProjectHarnessTarget = vi.fn().mockResolvedValue(target);
    const inspection = { target } as never;
    const service = {
      inspect: vi.fn().mockResolvedValue(inspection),
      preview: vi.fn(),
      apply: vi.fn(),
      update: vi.fn(),
    } as unknown as ProjectHarnessService;
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: { resolveProjectHarnessTarget } as never,
      service,
      logger: pino({ level: "silent" }),
    });

    await session.handleInspectRequest({
      type: "foundation.projectHarness.inspect.request",
      requestId: "req-1",
      projectId: target.projectId,
      workspaceId: target.workspaceId,
    });

    expect(resolveProjectHarnessTarget).toHaveBeenCalledWith({
      projectId: target.projectId,
      workspaceId: target.workspaceId,
    });
    expect(emitted).toEqual([
      {
        type: "foundation.projectHarness.inspect.response",
        payload: { requestId: "req-1", ok: true, inspection },
      },
    ]);
  });

  it("returns a structured error instead of turning a transaction conflict into a generic RPC failure", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const service = {
      inspect: vi
        .fn()
        .mockRejectedValue(
          new ProjectHarnessServiceError("stale_plan", "fresh preview required", ["AGENTS.md"]),
        ),
      preview: vi.fn(),
      apply: vi.fn(),
      update: vi.fn(),
    } as unknown as ProjectHarnessService;
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: {
        resolveProjectHarnessTarget: vi.fn().mockResolvedValue(target),
      } as never,
      service,
      logger: pino({ level: "silent" }),
    });

    await session.handleInspectRequest({
      type: "foundation.projectHarness.inspect.request",
      requestId: "req-2",
      projectId: target.projectId,
      workspaceId: target.workspaceId,
    });

    expect(emitted[0]).toMatchObject({
      type: "foundation.projectHarness.inspect.response",
      payload: {
        requestId: "req-2",
        ok: false,
        error: { code: "stale_plan", paths: ["AGENTS.md"] },
      },
    });
  });

  it("dispatches an authorized writer release with identity and CAS selectors", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const resolveProjectHarnessTarget = vi.fn().mockResolvedValue(target);
    const releaseResult = {
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      notebookId: "nb_release",
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      releasedWriterId: "writer-1",
      metadataRevision: {
        status: "regular",
        mtimeMs: 1,
        size: 2,
        sha256: "a".repeat(64),
      },
      nextStep: "fresh_supervisor_role_first",
    };
    const release = vi.fn().mockResolvedValue(releaseResult);
    const expectedRevision = {
      status: "regular" as const,
      mtimeMs: 0,
      size: 1,
      sha256: "b".repeat(64),
    };
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: { resolveProjectHarnessTarget } as never,
      service: { inspect: vi.fn(), preview: vi.fn(), apply: vi.fn(), update: vi.fn() } as never,
      bindingResolver: { release } as never,
      agentManager: {
        getAgent: vi.fn(() => ({ id: "writer-1", lifecycle: "idle" })),
        isAgentCloseInFlight: vi.fn(() => false),
        hasInFlightRun: vi.fn(() => false),
      } as never,
      logger: pino({ level: "silent" }),
    });

    await session.handleNotebookReleaseRequest({
      type: "foundation.projectHarness.notebook.release.request",
      requestId: "req-release",
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      cwd: target.cwd,
      notebookId: "nb_release",
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      designatedWriterId: "writer-1",
      expectedRevision,
    });

    expect(release).toHaveBeenCalledWith({
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      cwd: target.cwd,
      notebookId: "nb_release",
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      designatedWriterId: "writer-1",
      expectedRevision,
      revalidate: expect.any(Function),
    });
    expect(emitted).toEqual([
      {
        type: "foundation.projectHarness.notebook.release.response",
        payload: { requestId: "req-release", ok: true, result: releaseResult },
      },
    ]);
  });

  it("fails closed when the designated writer is active or its lifecycle is unknown", async () => {
    const request = {
      type: "foundation.projectHarness.notebook.release.request" as const,
      requestId: "req-release-lifecycle",
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      cwd: target.cwd,
      notebookId: "nb_release",
      location: "docs/harness/SUPERVISOR_NOTEBOOK.md",
      designatedWriterId: "writer-1",
      expectedRevision: {
        status: "regular" as const,
        mtimeMs: 1,
        size: 2,
        sha256: "a".repeat(64),
      },
    };
    for (const lifecycle of ["running", undefined] as const) {
      const emitted: SessionOutboundMessage[] = [];
      const release = vi.fn();
      const session = new ProjectHarnessSession({
        host: { emit: (message) => emitted.push(message) },
        workspaceProvisioning: {
          resolveProjectHarnessTarget: vi.fn().mockResolvedValue(target),
        } as never,
        service: { inspect: vi.fn(), preview: vi.fn(), apply: vi.fn(), update: vi.fn() } as never,
        bindingResolver: { release } as never,
        agentManager: {
          getAgent: vi.fn(() => (lifecycle ? { id: "writer-1", lifecycle } : null)),
          isAgentCloseInFlight: vi.fn(() => false),
          hasInFlightRun: vi.fn(() => false),
        } as never,
        logger: pino({ level: "silent" }),
      });

      await session.handleNotebookReleaseRequest(request);

      expect(release).not.toHaveBeenCalled();
      expect(emitted[0]).toMatchObject({
        type: "foundation.projectHarness.notebook.release.response",
        payload: {
          requestId: request.requestId,
          ok: false,
          error: {
            code: lifecycle
              ? "notebook_release_lifecycle_active"
              : "notebook_release_lifecycle_unknown",
          },
        },
      });
    }
  });

  it("revalidates a queued release for a pending run before clearing the claim", async () => {
    const fixture = await makeReleaseFixture();
    const initialLifecycleObserved = deferred<void>();
    let pendingRun = false;
    const agentManager = {
      getAgent: vi.fn(() => {
        initialLifecycleObserved.resolve();
        return { id: fixture.writerId, lifecycle: "idle" as const };
      }),
      isAgentCloseInFlight: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => pendingRun),
    };
    const emitted: SessionOutboundMessage[] = [];
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: {
        resolveProjectHarnessTarget: vi.fn().mockResolvedValue(fixture.target),
      } as never,
      service: { inspect: vi.fn(), preview: vi.fn(), apply: vi.fn(), update: vi.fn() } as never,
      bindingResolver: fixture.resolver,
      agentManager: agentManager as never,
      logger: pino({ level: "silent" }),
    });
    const metadataPath = join(fixture.root, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
    const before = await readFile(metadataPath, "utf8");
    const holdEntered = deferred<void>();
    const releaseHold = deferred<void>();
    const holdPath = "queue-hold.txt";
    const holdExpected = inspectProjectHarnessFile(fixture.root, holdPath).revision;
    const hold = applyProjectHarnessFileTransaction({
      rootPath: fixture.root,
      guards: [{ path: holdPath, expected: holdExpected }],
      writes: [{ path: holdPath, expected: holdExpected, content: "queue holder\n" }],
      beforeCommit: async () => {
        holdEntered.resolve();
        await releaseHold.promise;
      },
    });

    await holdEntered.promise;
    const request = { ...fixture.request, requestId: "release-race-pending" };
    const release = session.handleNotebookReleaseRequest(request);
    await initialLifecycleObserved.promise;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(agentManager.hasInFlightRun).toHaveBeenCalledTimes(1);

    // The initial handler snapshot was idle; the authoritative runtime now has
    // a pending run while the existing root transaction queue is still held.
    pendingRun = true;
    releaseHold.resolve();
    await hold;
    await release;

    expect(emitted[0]).toMatchObject({
      type: "foundation.projectHarness.notebook.release.response",
      payload: {
        requestId: request.requestId,
        ok: false,
        error: { code: "notebook_release_lifecycle_active" },
      },
    });
    await expect(readFile(metadataPath, "utf8")).resolves.toBe(before);
    const metadata = inspectHarnessProjectMetadata(
      fixture.root,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(metadata.status === "valid" ? metadata.metadata.supervisorNotebook : undefined).toEqual(
      fixture.claim,
    );
    expect(agentManager.getAgent).toHaveBeenCalledTimes(2);
    expect(agentManager.hasInFlightRun).toHaveBeenCalledTimes(2);
  });

  it("allows a queued release when the mutation-boundary runtime remains idle", async () => {
    const fixture = await makeReleaseFixture();
    const initialLifecycleObserved = deferred<void>();
    const agentManager = {
      getAgent: vi.fn(() => {
        initialLifecycleObserved.resolve();
        return { id: fixture.writerId, lifecycle: "idle" as const };
      }),
      isAgentCloseInFlight: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
    };
    const emitted: SessionOutboundMessage[] = [];
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: {
        resolveProjectHarnessTarget: vi.fn().mockResolvedValue(fixture.target),
      } as never,
      service: { inspect: vi.fn(), preview: vi.fn(), apply: vi.fn(), update: vi.fn() } as never,
      bindingResolver: fixture.resolver,
      agentManager: agentManager as never,
      logger: pino({ level: "silent" }),
    });
    const holdEntered = deferred<void>();
    const releaseHold = deferred<void>();
    const holdPath = "queue-hold.txt";
    const holdExpected = inspectProjectHarnessFile(fixture.root, holdPath).revision;
    const hold = applyProjectHarnessFileTransaction({
      rootPath: fixture.root,
      guards: [{ path: holdPath, expected: holdExpected }],
      writes: [{ path: holdPath, expected: holdExpected, content: "queue holder\n" }],
      beforeCommit: async () => {
        holdEntered.resolve();
        await releaseHold.promise;
      },
    });

    await holdEntered.promise;
    const request = { ...fixture.request, requestId: "release-race-idle" };
    const release = session.handleNotebookReleaseRequest(request);
    await initialLifecycleObserved.promise;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(agentManager.hasInFlightRun).toHaveBeenCalledTimes(1);

    releaseHold.resolve();
    await hold;
    await release;

    expect(emitted[0]).toMatchObject({
      type: "foundation.projectHarness.notebook.release.response",
      payload: {
        requestId: request.requestId,
        ok: true,
        result: {
          projectId: fixture.projectId,
          workspaceId: fixture.workspaceId,
          notebookId: fixture.claim.notebookId,
          location: fixture.claim.location,
          releasedWriterId: fixture.writerId,
          nextStep: "fresh_supervisor_role_first",
        },
      },
    });
    const metadata = inspectHarnessProjectMetadata(
      fixture.root,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    expect(metadata.status === "valid" ? metadata.metadata.supervisorNotebook : undefined).toBe(
      undefined,
    );
    expect(
      metadata.status === "valid" ? metadata.metadata.supervisorNotebookIdentity : undefined,
    ).toEqual({ notebookId: fixture.claim.notebookId, location: fixture.claim.location });
    await expect(readFile(join(fixture.root, holdPath), "utf8")).resolves.toBe("queue holder\n");
    expect(agentManager.getAgent).toHaveBeenCalledTimes(3);
    expect(agentManager.hasInFlightRun).toHaveBeenCalledTimes(3);
  });

  it("rejects a lifecycle change observed after staging and before the first rename", async () => {
    const stageEntered = deferred<void>();
    const releaseStage = deferred<void>();
    const fixture = await makeReleaseFixture({
      testing: {
        beforeFirstRename: async () => {
          expect(existsSync(join(fixture.root, ".paseo/.project-harness-transactions"))).toBe(true);
          stageEntered.resolve();
          await releaseStage.promise;
        },
      },
    });
    const metadataPath = join(fixture.root, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
    const before = await readFile(metadataPath, "utf8");
    let pendingRun = false;
    const agentManager = {
      getAgent: vi.fn(() => ({ id: fixture.writerId, lifecycle: "idle" as const })),
      isAgentCloseInFlight: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => pendingRun),
    };
    const emitted: SessionOutboundMessage[] = [];
    const session = new ProjectHarnessSession({
      host: { emit: (message) => emitted.push(message) },
      workspaceProvisioning: {
        resolveProjectHarnessTarget: vi.fn().mockResolvedValue(fixture.target),
      } as never,
      service: { inspect: vi.fn(), preview: vi.fn(), apply: vi.fn(), update: vi.fn() } as never,
      bindingResolver: fixture.resolver,
      agentManager: agentManager as never,
      logger: pino({ level: "silent" }),
    });

    const release = session.handleNotebookReleaseRequest({
      ...fixture.request,
      requestId: "release-race-staged-window",
    });
    await stageEntered.promise;
    pendingRun = true;
    releaseStage.resolve();
    await release;

    expect(emitted[0]).toMatchObject({
      type: "foundation.projectHarness.notebook.release.response",
      payload: {
        requestId: "release-race-staged-window",
        ok: false,
        error: { code: "notebook_release_lifecycle_active" },
      },
    });
    await expect(readFile(metadataPath, "utf8")).resolves.toBe(before);
    expect((await inspectProjectHarnessTransactions(fixture.root)).status).toBe("none");
    expect(agentManager.hasInFlightRun).toHaveBeenCalledTimes(3);
  });
});
