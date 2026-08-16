import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";
import { PortfolioRecordSchema } from "@getpaseo/protocol/portfolio/rpc-schemas";
import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

const StoredPortfoliosSchema = z.array(PortfolioRecordSchema);

export function generatePortfolioId(): string {
  return `pf_${randomBytes(8).toString("hex")}`;
}

export type PortfolioJsonWriter = (filePath: string, value: unknown) => Promise<void>;

export interface PortfolioMutationContext {
  listAll(): PortfolioRecord[];
  listActive(): PortfolioRecord[];
  get(portfolioId: string): PortfolioRecord | null;
  insert(record: PortfolioRecord): Promise<void>;
  update(
    portfolioId: string,
    updater: (record: PortfolioRecord) => PortfolioRecord,
  ): Promise<PortfolioRecord | null>;
}

export interface PortfolioStore {
  initialize(): Promise<void>;
  listAll(): Promise<PortfolioRecord[]>;
  listActive(): Promise<PortfolioRecord[]>;
  get(portfolioId: string): Promise<PortfolioRecord | null>;
  runMutation<T>(operation: (mutation: PortfolioMutationContext) => Promise<T>): Promise<T>;
}

function sortPortfolios(records: PortfolioRecord[]): PortfolioRecord[] {
  return [...records].sort((left, right) => {
    const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
    if (createdAtCompare !== 0) return createdAtCompare;
    return left.id.localeCompare(right.id);
  });
}

export class FileBackedPortfolioStore implements PortfolioStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly writeJson: PortfolioJsonWriter;
  private loaded = false;
  private readonly cache = new Map<string, PortfolioRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: { paseoHome: string; logger: Logger; writeJson?: PortfolioJsonWriter }) {
    this.filePath = path.join(options.paseoHome, "portfolios", "portfolios.json");
    this.logger = options.logger.child({ module: "portfolio", component: "store" });
    this.writeJson = options.writeJson ?? writeJsonFileAtomic;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async listAll(): Promise<PortfolioRecord[]> {
    await this.awaitMutations();
    await this.load();
    return sortPortfolios(Array.from(this.cache.values()));
  }

  async listActive(): Promise<PortfolioRecord[]> {
    const portfolios = await this.listAll();
    return portfolios.filter((portfolio) => portfolio.archivedAt === null);
  }

  async get(portfolioId: string): Promise<PortfolioRecord | null> {
    await this.awaitMutations();
    await this.load();
    return this.cache.get(portfolioId) ?? null;
  }

  async runMutation<T>(operation: (mutation: PortfolioMutationContext) => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.load();
      return await operation(this.createMutationContext());
    } finally {
      release();
    }
  }

  private createMutationContext(): PortfolioMutationContext {
    return {
      listAll: () => sortPortfolios(Array.from(this.cache.values())),
      listActive: () =>
        sortPortfolios(Array.from(this.cache.values())).filter(
          (portfolio) => portfolio.archivedAt === null,
        ),
      get: (portfolioId) => this.cache.get(portfolioId) ?? null,
      insert: async (record) => {
        const parsed = PortfolioRecordSchema.parse(record);
        this.cache.set(parsed.id, parsed);
        await this.enqueuePersist();
      },
      update: async (portfolioId, updater) => {
        const existing = this.cache.get(portfolioId);
        if (!existing) {
          return null;
        }
        const next = PortfolioRecordSchema.parse(updater(existing));
        this.cache.set(portfolioId, next);
        await this.enqueuePersist();
        return next;
      },
    };
  }

  private async awaitMutations(): Promise<void> {
    await this.mutationQueue;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = StoredPortfoliosSchema.parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, filePath: this.filePath }, "Failed to load portfolio store");
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const records = Array.from(this.cache.values()).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    await this.writeJson(this.filePath, records);
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}
