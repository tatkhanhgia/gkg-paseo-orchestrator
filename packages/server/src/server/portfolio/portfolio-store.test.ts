import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { FileBackedPortfolioStore } from "./portfolio-store.js";
import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";

describe("FileBackedPortfolioStore", () => {
  let paseoHome: string;
  let store: FileBackedPortfolioStore;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-portfolio-store-"));
    store = new FileBackedPortfolioStore({
      paseoHome,
      logger: pino({ level: "silent" }),
    });
    await store.initialize();
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("persists portfolios atomically under portfolios/portfolios.json", async () => {
    const record = {
      id: "pf_0123456789abcdef",
      name: "Core apps",
      projectIds: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      archivedAt: null,
    };

    await store.runMutation(async (mutation) => {
      await mutation.insert(record);
    });

    const raw = await readFile(path.join(paseoHome, "portfolios", "portfolios.json"), "utf8");
    expect(raw).toContain("Core apps");
    expect(await store.listAll()).toEqual([record]);
  });

  test("updates an existing portfolio record", async () => {
    await store.runMutation(async (mutation) => {
      await mutation.insert({
        id: "pf_0123456789abcdef",
        name: "Core apps",
        projectIds: [],
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        archivedAt: null,
      });
    });

    function appendProject(record: PortfolioRecord): PortfolioRecord {
      return {
        ...record,
        projectIds: ["prj_0123456789abcdef"],
        updatedAt: "2026-08-15T01:00:00.000Z",
      };
    }

    const updated = await store.runMutation((mutation) =>
      mutation.update("pf_0123456789abcdef", appendProject),
    );

    expect(updated).toEqual({
      id: "pf_0123456789abcdef",
      name: "Core apps",
      projectIds: ["prj_0123456789abcdef"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T01:00:00.000Z",
      archivedAt: null,
    });
  });

  test("recovers the persist queue after a failed write", async () => {
    let shouldFail = true;
    const failingStore = new FileBackedPortfolioStore({
      paseoHome,
      logger: pino({ level: "silent" }),
      writeJson: async (filePath, value) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("disk full");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    await failingStore.initialize();

    const first = {
      id: "pf_first",
      name: "First",
      projectIds: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      archivedAt: null,
    };
    const second = {
      id: "pf_second",
      name: "Second",
      projectIds: [],
      createdAt: "2026-08-15T00:00:01.000Z",
      updatedAt: "2026-08-15T00:00:01.000Z",
      archivedAt: null,
    };

    await expect(
      failingStore.runMutation(async (mutation) => {
        await mutation.insert(first);
      }),
    ).rejects.toThrow("disk full");

    await failingStore.runMutation(async (mutation) => {
      await mutation.insert(second);
    });

    const raw = await readFile(path.join(paseoHome, "portfolios", "portfolios.json"), "utf8");
    expect(raw).toContain("pf_first");
    expect(raw).toContain("pf_second");
    expect(await failingStore.listAll()).toEqual([first, second]);
  });
});
