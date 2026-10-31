import { randomUUID } from "node:crypto";
import type { FileErrorCode, Transfer, TransferState } from "../shared/contracts";

export const MAX_RUNNING_TRANSFERS = 4;
/** Finished records are kept so a poll can still read the result; this bounds that memory. */
export const MAX_FINISHED_TRANSFERS = 20;
const FINISHED_TTL_MS = 60 * 60_000;

export interface TransferRecord {
  id: string;
  kind: Transfer["kind"];
  fileName: string;
  /** Only this workspace may read or cancel the transfer. */
  workspaceId: string;
  state: TransferState;
  bytesDone: number;
  total: number | null;
  error?: { code: FileErrorCode; message: string };
  remotePath?: string;
  finishedAt?: number;
  /** Aborted by `cancel`; the transfer stops, removes its partial file, and ends `cancelled`. */
  abort: AbortController;
  /** Resolves once the transfer has ended or was discarded, after its cleanup ran. */
  settled: Promise<void>;
}

/**
 * Tracks transfers the daemon is running for the panel. At most `MAX_RUNNING_TRANSFERS` run at
 * once, and at most `MAX_FINISHED_TRANSFERS` finished records (none older than an hour) are kept,
 * so a long-lived daemon does not grow without bound.
 */
export class TransferRegistry {
  private readonly records = new Map<string, TransferRecord>();
  private readonly settle = new Map<string, () => void>();

  /** Registers a running transfer, or returns `null` when the running limit is reached. */
  begin(kind: Transfer["kind"], fileName: string, workspaceId: string): TransferRecord | null {
    this.prune();
    let running = 0;
    for (const record of this.records.values()) if (record.state === "running") running += 1;
    if (running >= MAX_RUNNING_TRANSFERS) return null;
    let markSettled = () => {};
    const record: TransferRecord = {
      id: randomUUID(),
      kind,
      fileName,
      workspaceId,
      state: "running",
      bytesDone: 0,
      total: null,
      abort: new AbortController(),
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    };
    this.settle.set(record.id, markSettled);
    this.records.set(record.id, record);
    return record;
  }

  /** The transfer, if it exists and was started by `workspaceId`. */
  get(id: string, workspaceId: string): TransferRecord | undefined {
    this.prune();
    const record = this.records.get(id);
    return record?.workspaceId === workspaceId ? record : undefined;
  }

  /** Forgets a transfer that failed before it started, so the caller reports the error itself. */
  discard(record: TransferRecord): void {
    this.records.delete(record.id);
    this.markSettled(record);
  }

  finish(
    record: TransferRecord,
    outcome: { state: Exclude<TransferState, "running">; error?: TransferRecord["error"] },
  ): void {
    record.state = outcome.state;
    record.error = outcome.error;
    record.finishedAt = Date.now();
    this.markSettled(record);
    this.prune();
  }

  /**
   * Aborts every running transfer and waits, for at most `waitMs`, until each has removed its
   * partial file and ended. Used when the plugin stops, so nothing is left half-written.
   */
  async shutdown(waitMs: number): Promise<void> {
    const running = [...this.records.values()].filter((record) => record.state === "running");
    for (const record of running) record.abort.abort();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([Promise.all(running.map((record) => record.settled)), timeout]);
    clearTimeout(timer);
  }

  private markSettled(record: TransferRecord): void {
    this.settle.get(record.id)?.();
    this.settle.delete(record.id);
  }

  private prune(): void {
    const now = Date.now();
    const finished: TransferRecord[] = [];
    for (const record of this.records.values()) {
      if (record.finishedAt === undefined) continue;
      if (now - record.finishedAt > FINISHED_TTL_MS) this.records.delete(record.id);
      else finished.push(record);
    }
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const stale of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TRANSFERS))) {
      this.records.delete(stale.id);
    }
  }
}

export function toTransfer(record: TransferRecord): Transfer {
  return {
    id: record.id,
    kind: record.kind,
    fileName: record.fileName,
    state: record.state,
    bytesDone: record.bytesDone,
    total: record.total,
    ...(record.error ? { error: record.error } : {}),
    ...(record.remotePath ? { remotePath: record.remotePath } : {}),
  };
}
