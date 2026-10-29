import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineSnapshot,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

interface CommittedTimeline {
  epoch: string;
  rows: AgentTimelineRow[];
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

interface TimelinePaths {
  root: string;
  rows: string;
  pending: string;
  metadata: string;
}

const TimelineRowSchema: z.ZodType<AgentTimelineRow, unknown> = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

const LegacyAtomicTimelineDocumentSchema = z.object({
  version: z.literal(1),
  epoch: z.string().min(1),
  nextSeq: z.number().int().positive(),
  rows: z.array(TimelineRowSchema),
  historyComplete: z.boolean().optional().default(false),
});

export interface FileAgentTimelineStoreOptions {
  writeJson?: typeof writeJsonFileAtomic;
}

function parseRow(agentId: string, value: unknown): AgentTimelineRow {
  try {
    return TimelineRowSchema.parse(value);
  } catch (error) {
    throw new Error(`Invalid durable timeline row for agent ${agentId}`, { cause: error });
  }
}

export class FileAgentTimelineStore implements AgentTimelineStore {
  // `memory` is the projected read view (collapsed rows, paged fetches). Committed rows stay raw
  // in `committed`: writes, conflict checks, and readback must see one row per sequence.
  private readonly memory = new InMemoryAgentTimelineStore();
  private readonly committed = new Map<string, CommittedTimeline>();
  private readonly historyComplete = new Map<string, boolean>();
  private readonly loaded = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly writeJson: typeof writeJsonFileAtomic;

  constructor(
    private readonly baseDir: string,
    options?: FileAgentTimelineStoreOptions | typeof writeJsonFileAtomic,
  ) {
    this.writeJson =
      typeof options === "function" ? options : (options?.writeJson ?? writeJsonFileAtomic);
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      const fetched = this.committedTimeline(agentId);
      const row: AgentTimelineRow = {
        seq: (fetched.rows.at(-1)?.seq ?? 0) + 1,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      };
      await this.persistRows(agentId, [row]);
      this.replaceMemory(agentId, fetched.epoch, [...fetched.rows, row]);
      return row;
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      return this.memory.fetch(agentId, options);
    });
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      return this.committedTimeline(agentId).rows.at(-1)?.seq ?? 0;
    });
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      return this.committedTimeline(agentId).rows.map(cloneRow);
    });
  }

  async getCommittedSnapshot(agentId: string): Promise<AgentTimelineSnapshot> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      return {
        rows: this.committedTimeline(agentId).rows.map(cloneRow),
        historyComplete: this.historyComplete.get(agentId) ?? false,
      };
    });
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      return this.memory.getLastItem(agentId);
    });
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      return this.memory.getLastAssistantMessage(agentId);
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    return this.withAgent(agentId, async () => {
      this.memory.delete(agentId);
      this.committed.delete(agentId);
      this.historyComplete.delete(agentId);
      this.loaded.delete(agentId);
      await fs.rm(this.paths(agentId).root, { recursive: true, force: true });
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      const fetched = this.committedTimeline(agentId);
      const existingBySeq = new Map(fetched.rows.map((row) => [row.seq, row]));
      const uniqueRows = [...new Map(rows.map((row) => [row.seq, row])).values()];
      for (const row of uniqueRows) {
        const existing = existingBySeq.get(row.seq);
        if (existing && !isDeepStrictEqual(existing, row)) {
          throw new Error(`Conflicting timeline row sequence ${row.seq}`);
        }
      }
      const additions = uniqueRows
        .filter((row) => !existingBySeq.has(row.seq))
        .toSorted((left, right) => left.seq - right.seq);
      if (additions.length === 0) return;
      await this.persistRows(agentId, additions);
      this.replaceMemory(agentId, fetched.epoch, [...fetched.rows, ...additions]);
    });
  }

  async replaceCommittedSnapshot(agentId: string, snapshot: AgentTimelineSnapshot): Promise<void> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      const fetched = this.committedTimeline(agentId);
      const rows = [...new Map(snapshot.rows.map((row) => [row.seq, row])).values()].toSorted(
        (left, right) => left.seq - right.seq,
      );
      await this.persistReplacement(agentId, fetched.epoch, rows, snapshot.historyComplete);
      this.replaceMemory(agentId, fetched.epoch, rows, snapshot.historyComplete);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    return this.withAgent(agentId, async () => {
      await this.prepare(agentId);
      const fetched = this.committedTimeline(agentId);
      const index = fetched.rows.findIndex((candidate) => candidate.seq === row.seq);
      if (index < 0) {
        throw new Error(`Cannot update missing timeline row sequence ${row.seq}`);
      }
      await this.persistRows(agentId, [row]);
      const updated: AgentTimelineRow[] = [...fetched.rows];
      updated[index] = row;
      this.replaceMemory(agentId, fetched.epoch, updated);
    });
  }

  private async withAgent<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(agentId, tail);
    void tail.finally(() => {
      if (this.tails.get(agentId) === tail) this.tails.delete(agentId);
    });
    return run;
  }

  private async ensureLoaded(agentId: string): Promise<void> {
    if (this.loaded.has(agentId)) return;
    const paths = this.paths(agentId);
    const metadataText = await fs
      .readFile(paths.metadata, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    let epoch: string = randomUUID();
    let historyComplete = false;
    if (metadataText) {
      const metadata: unknown = JSON.parse(metadataText);
      const storedEpoch =
        metadata && typeof metadata === "object" ? Reflect.get(metadata, "epoch") : undefined;
      if (typeof storedEpoch !== "string" || !storedEpoch) {
        throw new Error(`Invalid durable timeline metadata for agent ${agentId}`);
      }
      epoch = storedEpoch;
      historyComplete =
        metadata !== null &&
        typeof metadata === "object" &&
        Reflect.get(metadata, "historyComplete") === true;
    }
    const entries = await fs
      .readdir(paths.rows, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const rowFiles = entries
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .toSorted((left, right) => Number.parseInt(left.name, 10) - Number.parseInt(right.name, 10));
    let rows = await Promise.all(
      rowFiles.map(async (entry) => {
        const value: unknown = JSON.parse(
          await fs.readFile(path.join(paths.rows, entry.name), "utf8"),
        );
        return parseRow(agentId, value);
      }),
    );
    if (!metadataText && rows.length === 0) {
      const legacyText = await fs
        .readFile(this.legacyAtomicPath(agentId), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (legacyText) {
        const legacy = LegacyAtomicTimelineDocumentSchema.parse(JSON.parse(legacyText));
        let previousSeq = 0;
        for (const row of legacy.rows) {
          if (row.seq <= previousSeq) {
            throw new Error("Timeline rows must have strictly increasing sequence numbers");
          }
          previousSeq = row.seq;
        }
        if (legacy.nextSeq <= previousSeq) {
          throw new Error("Timeline nextSeq must be greater than every row sequence number");
        }
        epoch = legacy.epoch;
        historyComplete = legacy.historyComplete;
        rows = legacy.rows;
      }
    }
    this.replaceMemory(agentId, epoch, rows, historyComplete);
    this.loaded.add(agentId);
  }

  private async prepare(agentId: string): Promise<void> {
    await this.ensureLoaded(agentId);
    await this.reconcilePending(agentId);
  }

  private async reconcilePending(agentId: string): Promise<void> {
    const paths = this.paths(agentId);
    const entries = await fs
      .readdir(paths.pending, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const manifests = entries
      .filter((entry) => entry.isFile() && /^[0-9a-f-]+\.json$/.test(entry.name))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of manifests) {
      const manifestPath = path.join(paths.pending, entry.name);
      const value: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const rawRows = value && typeof value === "object" ? Reflect.get(value, "rows") : undefined;
      const epoch = value && typeof value === "object" ? Reflect.get(value, "epoch") : undefined;
      const replace = value && typeof value === "object" && Reflect.get(value, "replace") === true;
      const historyComplete =
        value && typeof value === "object" ? Reflect.get(value, "historyComplete") === true : false;
      if (!Array.isArray(rawRows) || typeof epoch !== "string" || !epoch) {
        throw new Error(`Invalid durable timeline manifest for agent ${agentId}`);
      }
      const rows = rawRows.map((row) => parseRow(agentId, row));
      await this.persistMetadataValue(agentId, epoch, historyComplete);
      if (replace) {
        await fs.rm(paths.rows, { recursive: true, force: true });
      }
      await this.commitRows(agentId, rows);
      const fetched = this.committedTimeline(agentId);
      this.replaceMemory(
        agentId,
        epoch,
        replace ? rows : [...fetched.rows, ...rows],
        historyComplete,
      );
      await fs.rm(manifestPath, { force: true });
    }
  }

  private async persistRows(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    const paths = this.paths(agentId);
    const normalized = [...new Map(rows.map((row) => [row.seq, row])).values()];
    if (normalized.length === 0) return;
    await fs.mkdir(paths.pending, { recursive: true });
    const epoch = this.committedTimeline(agentId).epoch;
    const manifestPath = path.join(paths.pending, `${randomUUID()}.json`);
    const historyComplete = this.historyComplete.get(agentId) ?? false;
    await this.writeJson(manifestPath, {
      version: 1,
      epoch,
      rows: normalized,
      historyComplete,
      replace: false,
    });
    await this.persistMetadataValue(agentId, epoch, historyComplete);
    await this.commitRows(agentId, normalized);
    await fs.rm(manifestPath, { force: true });
  }

  private async persistReplacement(
    agentId: string,
    epoch: string,
    rows: readonly AgentTimelineRow[],
    historyComplete: boolean,
  ): Promise<void> {
    const paths = this.paths(agentId);
    await fs.mkdir(paths.pending, { recursive: true });
    const manifestPath = path.join(paths.pending, `${randomUUID()}.json`);
    await this.writeJson(manifestPath, {
      version: 1,
      epoch,
      rows,
      historyComplete,
      replace: true,
    });
    await this.persistMetadataValue(agentId, epoch, historyComplete);
    await fs.rm(paths.rows, { recursive: true, force: true });
    await this.commitRows(agentId, rows);
    await fs.rm(manifestPath, { force: true });
  }

  private async commitRows(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    const paths = this.paths(agentId);
    await fs.mkdir(paths.rows, { recursive: true });
    await Promise.all(
      rows.map((row) => this.writeJson(path.join(paths.rows, `${row.seq}.json`), row)),
    );
  }

  private async persistMetadataValue(
    agentId: string,
    epoch: string,
    historyComplete = this.historyComplete.get(agentId) ?? false,
  ): Promise<void> {
    await this.writeJson(this.paths(agentId).metadata, { version: 1, epoch, historyComplete });
  }

  private replaceMemory(
    agentId: string,
    epoch: string,
    rows: readonly AgentTimelineRow[],
    historyComplete = this.historyComplete.get(agentId) ?? false,
  ): void {
    const ordered = [...new Map(rows.map((row) => [row.seq, row])).values()].toSorted(
      (left, right) => left.seq - right.seq,
    );
    this.committed.set(agentId, { epoch, rows: ordered.map(cloneRow) });
    this.memory.initialize(agentId, {
      epoch,
      rows: ordered,
      nextSeq: (ordered.at(-1)?.seq ?? 0) + 1,
    });
    this.historyComplete.set(agentId, historyComplete);
  }

  private committedTimeline(agentId: string): CommittedTimeline {
    const timeline = this.committed.get(agentId);
    if (!timeline) throw new Error(`Durable timeline for agent ${agentId} is not loaded`);
    return timeline;
  }

  private paths(agentId: string): TimelinePaths {
    const root = path.join(this.baseDir, encodeURIComponent(agentId));
    return {
      root,
      rows: path.join(root, "rows"),
      pending: path.join(root, "pending"),
      metadata: path.join(root, "metadata.json"),
    };
  }

  private legacyAtomicPath(agentId: string): string {
    return path.join(
      this.baseDir,
      `agent-${Buffer.from(agentId, "utf8").toString("base64url")}.json`,
    );
  }
}
