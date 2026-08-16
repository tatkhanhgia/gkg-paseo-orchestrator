import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { PersistedProjectRecord } from "../workspace-registry.js";
import { FileBackedPortfolioService, PortfolioServiceError } from "./portfolio-service.js";
import { FileBackedPortfolioStore } from "./portfolio-store.js";

function activeProject(projectId: string): PersistedProjectRecord {
  return {
    projectId,
    rootPath: `/tmp/${projectId}`,
    kind: "git",
    displayName: projectId,
    projectKey: null,
    workGraphId: null,
    customName: null,
    customIconRevision: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("FileBackedPortfolioService", () => {
  let paseoHome: string;
  let store: FileBackedPortfolioStore;
  let service: FileBackedPortfolioService;
  let projects: Map<string, PersistedProjectRecord>;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-portfolio-service-"));
    store = new FileBackedPortfolioStore({
      paseoHome,
      logger: pino({ level: "silent" }),
    });
    await store.initialize();
    projects = new Map([
      ["prj_alpha", activeProject("prj_alpha")],
      ["prj_beta", activeProject("prj_beta")],
    ]);
    service = new FileBackedPortfolioService(store, {
      get: async (projectId) => projects.get(projectId) ?? null,
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates portfolios with trimmed unique names", async () => {
    const created = await service.create("  Core apps  ");

    expect(created.name).toBe("Core apps");
    expect(created.projectIds).toEqual([]);
    expect(created.archivedAt).toBeNull();

    await expect(service.create("core apps")).rejects.toMatchObject<Partial<PortfolioServiceError>>(
      {
        code: "portfolio_name_taken",
      },
    );
  });

  test("list returns active portfolios only while get and archive still expose archived rows", async () => {
    const active = await service.create("Active");
    const retiring = await service.create("Retiring");
    const archived = await service.archive(retiring.id);

    expect(await service.list()).toEqual([active]);
    expect(await service.get(retiring.id)).toEqual(archived);
    expect(archived.archivedAt).toEqual(expect.stringMatching(/^2026-/u));
  });

  test("serializes concurrent create requests with the same name", async () => {
    const results = await Promise.allSettled([
      service.create("Shared name"),
      service.create("Shared name"),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject<Partial<PortfolioServiceError>>({
      code: "portfolio_name_taken",
    });
    expect(await service.list()).toHaveLength(1);
  });

  test("serializes concurrent add-project requests to enforce single membership", async () => {
    const first = await service.create("First");
    const second = await service.create("Second");

    const results = await Promise.allSettled([
      service.addProject(first.id, "prj_alpha"),
      service.addProject(second.id, "prj_alpha"),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" ? rejected[0].reason : null).toMatchObject<
      Partial<PortfolioServiceError>
    >({
      code: "project_in_other_portfolio",
    });

    const listed = await service.list();
    const owner = listed.find((portfolio) => portfolio.projectIds.includes("prj_alpha"));
    expect(owner?.projectIds).toEqual(["prj_alpha"]);
    expect(listed.filter((portfolio) => portfolio.projectIds.includes("prj_alpha"))).toHaveLength(
      1,
    );
  });

  test("enforces one active portfolio membership per project", async () => {
    const first = await service.create("First");
    const second = await service.create("Second");

    const withProject = await service.addProject(first.id, "prj_alpha");
    expect(withProject.projectIds).toEqual(["prj_alpha"]);

    await expect(service.addProject(second.id, "prj_alpha")).rejects.toMatchObject<
      Partial<PortfolioServiceError>
    >({
      code: "project_in_other_portfolio",
    });
  });

  test("requires an active project registry row before adding membership", async () => {
    const portfolio = await service.create("Apps");
    projects.set("prj_archived", {
      ...activeProject("prj_archived"),
      archivedAt: "2026-08-15T01:00:00.000Z",
    });

    await expect(service.addProject(portfolio.id, "prj_missing")).rejects.toMatchObject<
      Partial<PortfolioServiceError>
    >({
      code: "project_not_found",
    });
    await expect(service.addProject(portfolio.id, "prj_archived")).rejects.toMatchObject<
      Partial<PortfolioServiceError>
    >({
      code: "project_not_found",
    });
  });

  test("removeProjectFromAll scrubs membership from every portfolio including archived rows", async () => {
    const active = await service.create("Active");
    const archived = await service.create("Archived");
    await service.addProject(active.id, "prj_alpha");
    await service.addProject(archived.id, "prj_beta");
    await service.archive(archived.id);

    await service.removeProjectFromAll("prj_alpha");
    await service.removeProjectFromAll("prj_beta");

    expect((await service.get(active.id)).projectIds).toEqual([]);
    expect((await service.get(archived.id)).projectIds).toEqual([]);
  });

  test("removeProjectFromAll is idempotent when the project is unassigned", async () => {
    await service.create("Empty");

    await expect(service.removeProjectFromAll("prj_missing")).resolves.toBeUndefined();
  });

  test("remove membership is idempotent and archive does not archive projects", async () => {
    const portfolio = await service.create("Apps");
    await service.addProject(portfolio.id, "prj_alpha");

    const removed = await service.removeProject(portfolio.id, "prj_alpha");
    expect(removed.projectIds).toEqual([]);

    const removedAgain = await service.removeProject(portfolio.id, "prj_alpha");
    expect(removedAgain.projectIds).toEqual([]);

    await service.addProject(portfolio.id, "prj_beta");
    const archived = await service.archive(portfolio.id);

    expect(archived.archivedAt).toEqual(expect.stringMatching(/^2026-/u));
    expect(projects.get("prj_beta")?.archivedAt).toBeNull();
  });
});
