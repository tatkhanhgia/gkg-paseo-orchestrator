import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

import { createPersistedProjectRecord } from "../workspace-registry.js";
import { FileBackedPortfolioService } from "./portfolio-service.js";
import { FileBackedPortfolioStore } from "./portfolio-store.js";
import { Session, type SessionOptions } from "../session.js";
import {
  asAgentManager,
  asAgentStorage,
  asChatService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asLoopService,
  asPushTokenStore,
  asScheduleService,
  asWorkspaceGitService,
  createProviderSnapshotManagerStub,
  findByType,
} from "../test-utils/session-stubs.js";

describe("project.remove.request portfolio scrub hook", () => {
  let paseoHome: string;
  let portfolioService: FileBackedPortfolioService;
  let projects: Map<string, ReturnType<typeof createPersistedProjectRecord>>;
  let removeProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<void>>>;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-portfolio-project-remove-"));
    const store = new FileBackedPortfolioStore({
      paseoHome,
      logger: pino({ level: "silent" }),
    });
    await store.initialize();
    projects = new Map([
      [
        "prj_remove",
        createPersistedProjectRecord({
          projectId: "prj_remove",
          rootPath: "/tmp/prj_remove",
          kind: "git",
          displayName: "remove-me",
          createdAt: "2026-08-15T00:00:00.000Z",
          updatedAt: "2026-08-15T00:00:00.000Z",
        }),
      ],
    ]);
    removeProject = vi.fn(async (projectId: string) => {
      projects.delete(projectId);
    });
    portfolioService = new FileBackedPortfolioService(store, {
      get: async (projectId) => projects.get(projectId) ?? null,
      list: async () => Array.from(projects.values()),
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  function createSession(onMessage: (message: SessionOutboundMessage) => void): Session {
    const logger = pino({ level: "silent" });
    const sessionOptions: SessionOptions = {
      clientId: "test-client",
      scopes: ["*"],
      onMessage,
      logger,
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome,
      agentManager: asAgentManager({
        listAgents: vi.fn(() => []),
        listProviderSubagentActivity: vi.fn(() => []),
        subscribe: vi.fn(() => () => {}),
      }),
      agentStorage: asAgentStorage({
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(undefined),
      }),
      projectRegistry: {
        initialize: vi.fn(),
        existsOnDisk: vi.fn(),
        list: vi.fn(async () => Array.from(projects.values())),
        get: vi.fn(async (projectId: string) => projects.get(projectId) ?? null),
        getOrCreateActiveByRoot: vi.fn(),
        upsert: vi.fn(),
        archive: vi.fn(),
        remove: removeProject,
      },
      workspaceRegistry: {
        initialize: vi.fn(),
        existsOnDisk: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
        archive: vi.fn(),
        remove: vi.fn(),
      },
      chatService: asChatService(),
      portfolioService,
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        scheduleRefreshForCwd: vi.fn(),
      }),
      workspaceGitService: asWorkspaceGitService({
        resolveForge: vi.fn(),
      }),
      daemonConfigStore: asDaemonConfigStore({
        get: vi.fn(() => ({ mcp: { injectIntoAgents: false }, providers: {} })),
        onChange: vi.fn(() => () => {}),
      }),
      stt: null,
      tts: null,
      terminalManager: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    };
    return new Session(sessionOptions);
  }

  test("scrubs active portfolio membership before removing the project record", async () => {
    const portfolio = await portfolioService.create("Apps");
    await portfolioService.addProject(portfolio.id, "prj_remove");

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession((message) => emitted.push(message));

    await session.handleMessage({
      type: "project.remove.request",
      projectId: "prj_remove",
      requestId: "req-remove-with-portfolio",
    });

    expect(removeProject).toHaveBeenCalledWith("prj_remove");
    expect(projects.has("prj_remove")).toBe(false);
    expect((await portfolioService.get(portfolio.id)).projectIds).toEqual([]);
    expect(findByType(emitted, "project.remove.response")?.payload).toEqual({
      requestId: "req-remove-with-portfolio",
      projectId: "prj_remove",
      accepted: true,
      removedWorkspaceIds: [],
      error: null,
    });
  });
});
