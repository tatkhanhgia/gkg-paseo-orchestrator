import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ProjectHarnessFileRevision,
  ProjectHarnessFileSnapshot,
} from "@getpaseo/protocol/project-harness/rpc-schemas";

const TRANSACTION_ROOT = ".paseo/.project-harness-transactions";
const MANIFEST_NAME = "manifest.json";
const TRANSACTION_VERSION = 1;
const rootTransactionQueues = new Map<string, Promise<void>>();

export interface ProjectHarnessTransactionGuard {
  path: string;
  expected: ProjectHarnessFileRevision;
}

export interface ProjectHarnessTransactionWrite extends ProjectHarnessTransactionGuard {
  content: string;
}

export interface ProjectHarnessTransactionOptions {
  rootPath: string;
  guards: readonly ProjectHarnessTransactionGuard[];
  writes: readonly ProjectHarnessTransactionWrite[];
  /** Internal mutation-boundary validation; invoked while the root queue is held. */
  beforeCommit?: () => void | Promise<void>;
  /** Synchronous validation immediately before the first destructive rename. */
  beforeFirstRename?: () => void;
  /** Test-only interruption point; production callers leave this unset. */
  testing?: {
    interruptAfterCommit?: number;
    beforeFirstRename?: () => void | Promise<void>;
  };
}

export type ProjectHarnessTransactionResult =
  | {
      ok: true;
      transactionId: string;
      changedPaths: string[];
      recoveredTransactionIds: string[];
    }
  | {
      ok: false;
      error: {
        code:
          | "conflict"
          | "invalid_path"
          | "unsupported_target"
          | "write_failed"
          | "recovery_required";
        paths?: string[];
        transactionId?: string;
        recoveredTransactionIds: string[];
      };
    };

export type ProjectHarnessRecoveryResult =
  | { status: "none" | "recovered"; transactionIds: string[] }
  | { status: "blocked"; transactionIds: string[]; reason: string };

export type ProjectHarnessRecoveryInspection =
  | { status: "none" | "pending"; transactionIds: string[] }
  | { status: "blocked"; transactionIds: string[]; reason: string };

interface TransactionManifestFile {
  path: string;
  expected: ProjectHarnessFileRevision;
  originalStatus: "missing" | "regular";
  stagePath: string;
  backupPath: string;
  installedSha256: string;
  installedSize: number;
  committed: boolean;
}

interface TransactionManifest {
  version: 1;
  transactionId: string;
  phase: "staged" | "committing" | "committed" | "needs_recovery";
  files: TransactionManifestFile[];
}

interface TransactionDirectory {
  transactionId: string;
  directoryPath: string;
  manifestPath: string;
}

class ProjectHarnessPathError extends Error {}

function pathErrorCode(error: unknown): "invalid_path" | "unsupported_target" {
  return error instanceof ProjectHarnessPathError && error.message.includes("symlink")
    ? "unsupported_target"
    : "invalid_path";
}

async function withProjectHarnessTransactionLock<T>(
  rootPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = resolve(rootPath);
  const previous = rootTransactionQueues.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolveNext) => {
    release = resolveNext;
  });
  const queued = previous.then(() => next);
  rootTransactionQueues.set(lockKey, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (rootTransactionQueues.get(lockKey) === queued) {
      rootTransactionQueues.delete(lockKey);
    }
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function nearestExistingRealAncestor(path: string): string {
  let candidate = path;
  for (;;) {
    try {
      return realpathSync(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new ProjectHarnessPathError(`no existing ancestor found for path: ${path}`);
      }
      candidate = parent;
    }
  }
}

function resolveContainedPath(rootPath: string, relativePath: string): string {
  if (relativePath.trim().length === 0 || isAbsolute(relativePath)) {
    throw new ProjectHarnessPathError("path must be a non-empty relative path");
  }
  const root = resolve(rootPath);
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) {
    throw new ProjectHarnessPathError(`path escapes project root: ${relativePath}`);
  }
  const realRoot = realpathSync(root);
  const realAncestor = nearestExistingRealAncestor(dirname(path));
  if (!isInside(realRoot, realAncestor)) {
    throw new ProjectHarnessPathError(
      `path escapes project root through a symlink: ${relativePath}`,
    );
  }
  return path;
}

function missingRevision(): ProjectHarnessFileRevision {
  return { status: "missing", mtimeMs: null, size: null, sha256: null };
}

function unreadableRevision(): ProjectHarnessFileRevision {
  return { status: "unreadable", mtimeMs: null, size: null, sha256: null };
}

function snapshotRevisionMatches(
  left: ProjectHarnessFileRevision,
  right: ProjectHarnessFileRevision,
): boolean {
  return (
    left.status === right.status &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.symlinkTarget === right.symlinkTarget
  );
}

function revisionFromRegularFile(path: string, bytes: Buffer): ProjectHarnessFileRevision {
  const stats = statSync(path);
  return {
    status: "regular",
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    sha256: sha256(bytes),
  };
}

function snapshotPath(rootPath: string, relativePath: string): ProjectHarnessFileSnapshot {
  let path: string;
  try {
    path = resolveContainedPath(rootPath, relativePath);
  } catch {
    return { path: relativePath, revision: unreadableRevision() };
  }

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: relativePath, revision: missingRevision() };
    }
    return { path: relativePath, revision: unreadableRevision() };
  }

  if (stats.isSymbolicLink()) {
    try {
      const target = readlinkSync(path);
      return {
        path: relativePath,
        revision: {
          status: "symlink",
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          sha256: sha256(`symlink:${target}`),
          symlinkTarget: target,
        },
      };
    } catch {
      return { path: relativePath, revision: unreadableRevision() };
    }
  }
  if (!stats.isFile()) return { path: relativePath, revision: unreadableRevision() };

  try {
    const bytes = readFileSync(path);
    return {
      path: relativePath,
      revision: revisionFromRegularFile(path, bytes),
      content: bytes.toString("utf8"),
    };
  } catch {
    return { path: relativePath, revision: unreadableRevision() };
  }
}

export function inspectProjectHarnessFile(
  rootPath: string,
  relativePath: string,
): ProjectHarnessFileSnapshot {
  return snapshotPath(rootPath, relativePath);
}

function transactionDirectory(rootPath: string, transactionId: string): TransactionDirectory {
  if (!/^[a-f0-9-]{16,80}$/u.test(transactionId)) {
    throw new ProjectHarnessPathError("invalid transaction id");
  }
  const directoryPath = resolveContainedPath(rootPath, join(TRANSACTION_ROOT, transactionId));
  return {
    transactionId,
    directoryPath,
    manifestPath: join(directoryPath, MANIFEST_NAME),
  };
}

async function writeManifest(path: string, manifest: TransactionManifest): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isValidRevision(value: unknown): value is ProjectHarnessFileRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const revision = value as Partial<ProjectHarnessFileRevision>;
  if (
    !["missing", "regular", "symlink", "unreadable"].includes(revision.status ?? "") ||
    (revision.mtimeMs !== null &&
      (typeof revision.mtimeMs !== "number" || !Number.isFinite(revision.mtimeMs))) ||
    (revision.size !== null &&
      (typeof revision.size !== "number" || !Number.isInteger(revision.size) || revision.size < 0))
  ) {
    return false;
  }
  if (revision.status === "regular") {
    return isSha256(revision.sha256) && revision.size !== null;
  }
  if (revision.status === "symlink") {
    return (
      isSha256(revision.sha256) &&
      revision.size !== null &&
      typeof revision.symlinkTarget === "string"
    );
  }
  return revision.mtimeMs === null && revision.size === null && revision.sha256 === null;
}

function isSafeRelativeJournalPath(value: string): boolean {
  if (value.trim().length === 0 || isAbsolute(value)) return false;
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSafeRelativeTargetPath(value: string): boolean {
  if (value.trim().length === 0 || isAbsolute(value)) return false;
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

// eslint-disable-next-line complexity -- journal validation intentionally checks every persisted field before recovery.
function isValidManifestFile(value: unknown, paths: Set<string>): value is TransactionManifestFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<TransactionManifestFile>;
  const expected = entry.expected as ProjectHarnessFileRevision | undefined;
  if (
    typeof entry.path !== "string" ||
    !isSafeRelativeTargetPath(entry.path) ||
    paths.has(entry.path) ||
    !expected ||
    !isValidRevision(expected) ||
    (expected.status !== "missing" && expected.status !== "regular") ||
    entry.originalStatus !== expected.status ||
    typeof entry.stagePath !== "string" ||
    !isSafeRelativeJournalPath(entry.stagePath) ||
    typeof entry.backupPath !== "string" ||
    !isSafeRelativeJournalPath(entry.backupPath) ||
    entry.stagePath === entry.backupPath ||
    !isSha256(entry.installedSha256) ||
    typeof entry.installedSize !== "number" ||
    !Number.isInteger(entry.installedSize) ||
    entry.installedSize < 0 ||
    typeof entry.committed !== "boolean"
  ) {
    return false;
  }
  paths.add(entry.path);
  return true;
}

function parseManifest(value: unknown): TransactionManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<TransactionManifest>;
  if (
    candidate.version !== TRANSACTION_VERSION ||
    typeof candidate.transactionId !== "string" ||
    !/^[a-f0-9-]{16,80}$/u.test(candidate.transactionId) ||
    !["staged", "committing", "committed", "needs_recovery"].includes(candidate.phase ?? "") ||
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0 ||
    candidate.files.length > 16
  ) {
    return null;
  }
  const files = candidate.files as unknown[];
  const paths = new Set<string>();
  if (files.some((file) => !isValidManifestFile(file, paths))) {
    return null;
  }
  return candidate as TransactionManifest;
}

async function readManifest(
  transaction: TransactionDirectory,
): Promise<TransactionManifest | null> {
  try {
    const manifestStats = lstatSync(transaction.manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return null;
    const realManifestPath = realpathSync(transaction.manifestPath);
    const realTransactionPath = realpathSync(transaction.directoryPath);
    if (!isInside(realTransactionPath, realManifestPath)) return null;
    const raw: unknown = JSON.parse(await readFile(transaction.manifestPath, "utf8"));
    return parseManifest(raw);
  } catch {
    return null;
  }
}

async function listTransactionDirectories(rootPath: string): Promise<TransactionDirectory[]> {
  const transactionRoot = resolveContainedPath(rootPath, TRANSACTION_ROOT);
  let transactionRootStats: ReturnType<typeof lstatSync>;
  try {
    transactionRootStats = lstatSync(transactionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!transactionRootStats.isDirectory() || transactionRootStats.isSymbolicLink()) {
    throw new ProjectHarnessPathError("transaction root is not a real project directory");
  }
  const realRoot = realpathSync(resolve(rootPath));
  const realTransactionRoot = realpathSync(transactionRoot);
  if (!isInside(realRoot, realTransactionRoot)) {
    throw new ProjectHarnessPathError("transaction root escapes project root");
  }
  let names: string[];
  try {
    names = await readdir(transactionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.some((name) => !/^[a-f0-9-]{16,80}$/u.test(name))) {
    throw new ProjectHarnessPathError("transaction root contains an unsafe journal entry");
  }
  const transactions = names.map((name) => transactionDirectory(rootPath, name));
  for (const transaction of transactions) {
    const stats = lstatSync(transaction.directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ProjectHarnessPathError("transaction journal entry is not a real directory");
    }
    const realDirectory = realpathSync(transaction.directoryPath);
    if (!isInside(realRoot, realDirectory)) {
      throw new ProjectHarnessPathError("transaction journal entry escapes project root");
    }
  }
  return transactions;
}

async function inspectProjectHarnessTransactionsUnlocked(
  rootPath: string,
): Promise<ProjectHarnessRecoveryInspection> {
  let transactions: TransactionDirectory[];
  try {
    transactions = await listTransactionDirectories(rootPath);
  } catch (error) {
    return {
      status: "blocked",
      transactionIds: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (transactions.length === 0) return { status: "none", transactionIds: [] };
  for (const transaction of transactions) {
    if (!(await readManifest(transaction))) {
      return {
        status: "blocked",
        transactionIds: transactions.map((candidate) => candidate.transactionId),
        reason: `unreadable or unsafe transaction manifest: ${transaction.manifestPath}`,
      };
    }
  }
  return {
    status: "pending",
    transactionIds: transactions.map((candidate) => candidate.transactionId),
  };
}

export async function inspectProjectHarnessTransactions(
  rootPath: string,
): Promise<ProjectHarnessRecoveryInspection> {
  return withProjectHarnessTransactionLock(rootPath, () =>
    inspectProjectHarnessTransactionsUnlocked(rootPath),
  );
}

function pathFromManifest(transaction: TransactionDirectory, value: string): string {
  if (!isSafeRelativeJournalPath(value)) {
    throw new ProjectHarnessPathError("transaction journal path is unsafe");
  }
  const absolute = resolve(transaction.directoryPath, value);
  const relativeToTransaction = relative(transaction.directoryPath, absolute);
  if (
    relativeToTransaction.length === 0 ||
    relativeToTransaction.startsWith("../") ||
    relativeToTransaction === ".." ||
    isAbsolute(relativeToTransaction)
  ) {
    throw new ProjectHarnessPathError("transaction journal path escapes its directory");
  }
  return absolute;
}

async function removeTransactionDirectory(directoryPath: string): Promise<void> {
  await rm(directoryPath, { recursive: true, force: true });
}

type JournalFileState =
  | { status: "missing" }
  | { status: "regular"; sha256: string; size: number }
  | { status: "unsafe"; reason: string };

function inspectJournalFile(
  transaction: TransactionDirectory,
  relativePath: string,
): JournalFileState {
  let path: string;
  try {
    path = pathFromManifest(transaction, relativePath);
  } catch (error) {
    return { status: "unsafe", reason: error instanceof Error ? error.message : String(error) };
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unsafe", reason: `journal file cannot be inspected: ${path}` };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { status: "unsafe", reason: `journal file is not a regular file: ${path}` };
  }
  try {
    const realPath = realpathSync(path);
    const realDirectory = realpathSync(transaction.directoryPath);
    if (!isInside(realDirectory, realPath)) {
      return { status: "unsafe", reason: `journal file escapes its transaction: ${path}` };
    }
    const bytes = readFileSync(path);
    return { status: "regular", sha256: sha256(bytes), size: bytes.byteLength };
  } catch {
    return { status: "unsafe", reason: `journal file is unreadable: ${path}` };
  }
}

// eslint-disable-next-line complexity -- journal validation intentionally checks every persisted byte and path before mutation.
function validateManifestJournal(
  rootPath: string,
  transaction: TransactionDirectory,
  manifest: TransactionManifest,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.transactionId !== transaction.transactionId) {
    return { ok: false, reason: "transaction manifest identity does not match its directory" };
  }
  const stagePaths = new Set<string>();
  const backupPaths = new Set<string>();
  for (const entry of manifest.files) {
    try {
      resolveContainedPath(rootPath, entry.path);
      const stagePath = pathFromManifest(transaction, entry.stagePath);
      const backupPath = pathFromManifest(transaction, entry.backupPath);
      if (
        stagePaths.has(stagePath) ||
        backupPaths.has(stagePath) ||
        stagePaths.has(backupPath) ||
        backupPaths.has(backupPath) ||
        stagePath === backupPath
      ) {
        return { ok: false, reason: `transaction journal paths are not unique at ${entry.path}` };
      }
      stagePaths.add(stagePath);
      backupPaths.add(backupPath);
      const stage = inspectJournalFile(transaction, entry.stagePath);
      if (stage.status === "unsafe") return { ok: false, reason: stage.reason };
      if (
        stage.status === "regular" &&
        (stage.sha256 !== entry.installedSha256 || stage.size !== entry.installedSize)
      ) {
        return { ok: false, reason: `staged bytes changed at ${entry.path}` };
      }
      if (manifest.phase === "staged" && stage.status !== "regular") {
        return { ok: false, reason: `staged transaction is missing staged bytes at ${entry.path}` };
      }
      if (manifest.phase === "committed" && stage.status !== "missing") {
        return { ok: false, reason: `committed transaction retains staged bytes at ${entry.path}` };
      }

      const backup = inspectJournalFile(transaction, entry.backupPath);
      if (backup.status === "unsafe") return { ok: false, reason: backup.reason };
      if (entry.originalStatus === "missing" && backup.status !== "missing") {
        return {
          ok: false,
          reason: `new-file transaction has an unexpected backup at ${entry.path}`,
        };
      }
      if (backup.status === "regular") {
        if (
          entry.expected.status !== "regular" ||
          entry.expected.sha256 === null ||
          entry.expected.size === null ||
          backup.sha256 !== entry.expected.sha256 ||
          backup.size !== entry.expected.size
        ) {
          return { ok: false, reason: `original backup bytes changed at ${entry.path}` };
        }
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true };
}

type RecoveryAction =
  | { kind: "none"; entry: TransactionManifestFile; backupPath: string }
  | { kind: "remove_backup"; entry: TransactionManifestFile; backupPath: string }
  | {
      kind: "restore_backup";
      entry: TransactionManifestFile;
      targetPath: string;
      backupPath: string;
    }
  | { kind: "remove_installed"; entry: TransactionManifestFile; targetPath: string };

// eslint-disable-next-line complexity -- recovery branches are the persisted transaction state machine.
async function recoverManifest(
  rootPath: string,
  transaction: TransactionDirectory,
  manifest: TransactionManifest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const journal = validateManifestJournal(rootPath, transaction, manifest);
  if (!journal.ok) return journal;

  if (manifest.phase === "staged") {
    for (const entry of manifest.files) {
      if (entry.committed)
        return { ok: false, reason: `staged transaction has a committed file at ${entry.path}` };
      const current = snapshotPath(rootPath, entry.path);
      if (!snapshotRevisionMatches(current.revision, entry.expected)) {
        return { ok: false, reason: `staged transaction target changed at ${entry.path}` };
      }
    }
    await removeTransactionDirectory(transaction.directoryPath);
    return { ok: true };
  }

  if (manifest.phase === "committed") {
    for (const entry of manifest.files) {
      if (!entry.committed)
        return { ok: false, reason: `committed transaction is incomplete at ${entry.path}` };
      const current = snapshotPath(rootPath, entry.path);
      if (
        current.revision.status !== "regular" ||
        current.revision.sha256 !== entry.installedSha256 ||
        current.revision.size !== entry.installedSize
      ) {
        return { ok: false, reason: `committed transaction target changed at ${entry.path}` };
      }
    }
    await removeTransactionDirectory(transaction.directoryPath);
    return { ok: true };
  }

  const actions: RecoveryAction[] = [];
  for (const entry of manifest.files.toReversed()) {
    const targetPath = resolveContainedPath(rootPath, entry.path);
    const backupPath = pathFromManifest(transaction, entry.backupPath);
    const current = snapshotPath(rootPath, entry.path);
    const currentIsInstalled =
      current.revision.status === "regular" &&
      current.revision.sha256 === entry.installedSha256 &&
      current.revision.size === entry.installedSize;
    const currentIsExpected = snapshotRevisionMatches(current.revision, entry.expected);
    const backup = inspectJournalFile(transaction, entry.backupPath);
    const backupExists = backup.status === "regular";
    if (currentIsExpected) {
      actions.push(
        backupExists
          ? { kind: "remove_backup", entry, backupPath }
          : { kind: "none", entry, backupPath },
      );
      continue;
    }
    if (!currentIsInstalled && !backupExists) {
      return { ok: false, reason: `recovery conflict at ${entry.path}` };
    }
    // A crash can occur after the original was moved to its backup but before
    // the staged bytes were renamed into place. The target is then missing;
    // restoring the backup is the only safe recovery and does not overwrite
    // any user bytes.
    if (
      current.revision.status === "missing" &&
      backupExists &&
      entry.originalStatus === "regular"
    ) {
      actions.push({ kind: "restore_backup", entry, targetPath, backupPath });
      continue;
    }
    if (!currentIsInstalled) {
      return { ok: false, reason: `installed bytes changed at ${entry.path}` };
    }
    if (currentIsInstalled) {
      if (entry.originalStatus === "regular") {
        actions.push({ kind: "restore_backup", entry, targetPath, backupPath });
      } else {
        actions.push({ kind: "remove_installed", entry, targetPath });
      }
    }
  }

  for (const action of actions) {
    const current = snapshotPath(rootPath, action.entry.path);
    if (action.kind === "remove_backup" || action.kind === "none") {
      if (!snapshotRevisionMatches(current.revision, action.entry.expected)) {
        return { ok: false, reason: `recovery target changed at ${action.entry.path}` };
      }
      if (action.kind === "remove_backup") await rm(action.backupPath, { force: true });
      continue;
    }
    if (
      current.revision.status !== "regular" ||
      current.revision.sha256 !== action.entry.installedSha256 ||
      current.revision.size !== action.entry.installedSize
    ) {
      if (
        action.kind === "restore_backup" &&
        current.revision.status === "missing" &&
        action.entry.originalStatus === "regular"
      ) {
        // The target is allowed to be missing only for the crash window before
        // the staged bytes were installed.
      } else {
        return { ok: false, reason: `installed bytes changed at ${action.entry.path}` };
      }
    }
    if (action.kind === "remove_installed") {
      await rm(action.targetPath, { force: true });
      continue;
    }
    const backup = inspectJournalFile(transaction, action.entry.backupPath);
    if (backup.status !== "regular") {
      return { ok: false, reason: `original backup is unavailable at ${action.entry.path}` };
    }
    await rm(action.targetPath, { force: true });
    await rename(action.backupPath, action.targetPath);
  }

  await removeTransactionDirectory(transaction.directoryPath);
  return { ok: true };
}

export async function recoverProjectHarnessTransactions(
  rootPath: string,
): Promise<ProjectHarnessRecoveryResult> {
  return withProjectHarnessTransactionLock(rootPath, () =>
    recoverProjectHarnessTransactionsUnlocked(rootPath),
  );
}

async function recoverProjectHarnessTransactionsUnlocked(
  rootPath: string,
): Promise<ProjectHarnessRecoveryResult> {
  let transactions: TransactionDirectory[];
  try {
    transactions = await listTransactionDirectories(rootPath);
  } catch (error) {
    return {
      status: "blocked",
      transactionIds: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (transactions.length === 0) return { status: "none", transactionIds: [] };
  const recovered: string[] = [];
  for (const transaction of transactions) {
    const manifest = await readManifest(transaction);
    if (!manifest) {
      return {
        status: "blocked",
        transactionIds: transactions.map((candidate) => candidate.transactionId),
        reason: `unreadable or unsafe transaction manifest: ${transaction.manifestPath}`,
      };
    }
    let result: { ok: true } | { ok: false; reason: string };
    try {
      result = await recoverManifest(rootPath, transaction, manifest);
    } catch (error) {
      return {
        status: "blocked",
        transactionIds: transactions.map((candidate) => candidate.transactionId),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      return {
        status: "blocked",
        transactionIds: transactions.map((candidate) => candidate.transactionId),
        reason: result.reason,
      };
    }
    recovered.push(transaction.transactionId);
  }
  return { status: "recovered", transactionIds: recovered };
}

function validateUniquePaths(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length;
}

// The transaction state machine intentionally keeps preflight, staging, CAS,
// commit, and recovery failure paths together so the no-partial-write proof is
// visible at one boundary.
// eslint-disable-next-line complexity
async function applyProjectHarnessFileTransactionUnlocked(
  options: ProjectHarnessTransactionOptions,
): Promise<ProjectHarnessTransactionResult> {
  const recovery = await recoverProjectHarnessTransactionsUnlocked(options.rootPath);
  if (recovery.status === "blocked") {
    return {
      ok: false,
      error: {
        code: "recovery_required",
        paths: recovery.transactionIds,
        recoveredTransactionIds: [],
      },
    };
  }
  const recoveredTransactionIds = recovery.transactionIds;
  const guardPaths = options.guards.map((guard) => guard.path);
  const writePaths = options.writes.map((write) => write.path);
  if (!validateUniquePaths(guardPaths) || !validateUniquePaths(writePaths)) {
    return {
      ok: false,
      error: { code: "invalid_path", recoveredTransactionIds },
    };
  }

  const currentByPath = new Map<string, ProjectHarnessFileSnapshot>();
  for (const guard of options.guards) {
    try {
      resolveContainedPath(options.rootPath, guard.path);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: pathErrorCode(error),
          paths: [guard.path],
          recoveredTransactionIds,
        },
      };
    }
    const current = snapshotPath(options.rootPath, guard.path);
    currentByPath.set(guard.path, current);
    if (!snapshotRevisionMatches(current.revision, guard.expected)) {
      return {
        ok: false,
        error: { code: "conflict", paths: [guard.path], recoveredTransactionIds },
      };
    }
  }
  for (const write of options.writes) {
    const current = currentByPath.get(write.path) ?? snapshotPath(options.rootPath, write.path);
    if (!snapshotRevisionMatches(current.revision, write.expected)) {
      return {
        ok: false,
        error: { code: "conflict", paths: [write.path], recoveredTransactionIds },
      };
    }
    if (write.expected.status !== "missing" && write.expected.status !== "regular") {
      return {
        ok: false,
        error: { code: "unsupported_target", paths: [write.path], recoveredTransactionIds },
      };
    }
  }

  if (options.writes.length === 0) {
    return {
      ok: true,
      transactionId: `noop-${randomUUID()}`,
      changedPaths: [],
      recoveredTransactionIds,
    };
  }

  // Keep this callback inside the existing per-root queue and before the
  // journal/stage directory is created. Callers use it to revalidate
  // authority that is outside the file CAS (for example, runtime lifecycle)
  // at the actual mutation boundary.
  await options.beforeCommit?.();

  const transactionId = randomUUID();
  const transaction = transactionDirectory(options.rootPath, transactionId);
  const manifest: TransactionManifest = {
    version: TRANSACTION_VERSION,
    transactionId,
    phase: "staged",
    files: [],
  };

  try {
    await mkdir(transaction.directoryPath, { recursive: true, mode: 0o700 });
    for (const [index, write] of options.writes.entries()) {
      const originalStatus = write.expected.status;
      if (originalStatus !== "missing" && originalStatus !== "regular") {
        throw new ProjectHarnessPathError(`unsupported transaction target: ${write.path}`);
      }
      const stagePath = join(transaction.directoryPath, `stage-${index}.tmp`);
      const backupPath = join(transaction.directoryPath, `backup-${index}.bak`);
      await writeFile(stagePath, write.content, { encoding: "utf8", mode: 0o644 });
      manifest.files.push({
        path: write.path,
        expected: write.expected,
        originalStatus,
        stagePath: relative(transaction.directoryPath, stagePath).split(sep).join("/"),
        backupPath: relative(transaction.directoryPath, backupPath).split(sep).join("/"),
        installedSha256: sha256(Buffer.from(write.content)),
        installedSize: Buffer.byteLength(write.content),
        committed: false,
      });
    }
    await writeManifest(transaction.manifestPath, manifest);
    manifest.phase = "committing";
    await writeManifest(transaction.manifestPath, manifest);

    // Resolve all target parents before the final CAS and lifecycle guard so
    // no asynchronous filesystem work sits between that guard and rename.
    for (const entry of manifest.files) {
      const targetPath = resolveContainedPath(options.rootPath, entry.path);
      await mkdir(dirname(targetPath), { recursive: true });
    }
    for (const entry of manifest.files) {
      const current = snapshotPath(options.rootPath, entry.path);
      if (!snapshotRevisionMatches(current.revision, entry.expected)) {
        await removeTransactionDirectory(transaction.directoryPath);
        return {
          ok: false,
          error: { code: "conflict", paths: [entry.path], recoveredTransactionIds },
        };
      }
    }
  } catch {
    manifest.phase = "needs_recovery";
    try {
      await writeManifest(transaction.manifestPath, manifest);
    } catch {
      // The original error remains the best available evidence; the next call
      // will report a recovery-required state if the manifest is unreadable.
    }
    return {
      ok: false,
      error: {
        code: "write_failed",
        paths: manifest.files.filter((file) => file.committed).map((file) => file.path),
        transactionId,
        recoveredTransactionIds,
      },
    };
  }

  await options.testing?.beforeFirstRename?.();
  try {
    options.beforeFirstRename?.();
  } catch (error) {
    try {
      await removeTransactionDirectory(transaction.directoryPath);
    } catch {
      // Preserve the structured lifecycle error; a later call can recover the
      // staged journal if cleanup itself is interrupted.
    }
    throw error;
  }

  try {
    for (const [index, entry] of manifest.files.entries()) {
      // Re-check every not-yet-committed guard immediately before each rename.
      // A conflict after an earlier rename is left journaled for deterministic
      // recovery; a conflict before the first rename can discard the staged
      // journal without touching any project bytes.
      for (const guard of options.guards) {
        const committedEntry = manifest.files.find((candidate) => candidate.path === guard.path);
        if (committedEntry?.committed) continue;
        const current = snapshotPath(options.rootPath, guard.path);
        if (snapshotRevisionMatches(current.revision, guard.expected)) continue;
        if (!manifest.files.some((candidate) => candidate.committed)) {
          await removeTransactionDirectory(transaction.directoryPath);
          return {
            ok: false,
            error: { code: "conflict", paths: [guard.path], recoveredTransactionIds },
          };
        }
        manifest.phase = "needs_recovery";
        await writeManifest(transaction.manifestPath, manifest);
        return {
          ok: false,
          error: {
            code: "recovery_required",
            paths: [guard.path],
            transactionId,
            recoveredTransactionIds,
          },
        };
      }
      const targetPath = resolveContainedPath(options.rootPath, entry.path);
      const stagePath = pathFromManifest(transaction, entry.stagePath);
      const backupPath = pathFromManifest(transaction, entry.backupPath);
      const current = snapshotPath(options.rootPath, entry.path);
      if (!snapshotRevisionMatches(current.revision, entry.expected)) {
        if (manifest.files.some((candidate) => candidate.committed)) {
          manifest.phase = "needs_recovery";
          await writeManifest(transaction.manifestPath, manifest);
          return {
            ok: false,
            error: {
              code: "recovery_required",
              paths: [entry.path],
              transactionId,
              recoveredTransactionIds,
            },
          };
        }
        await removeTransactionDirectory(transaction.directoryPath);
        return {
          ok: false,
          error: { code: "conflict", paths: [entry.path], recoveredTransactionIds },
        };
      }
      if (entry.originalStatus === "regular") {
        await rename(targetPath, backupPath);
      }
      await rename(stagePath, targetPath);
      entry.committed = true;
      await writeManifest(transaction.manifestPath, manifest);
      if (options.testing?.interruptAfterCommit === index) {
        manifest.phase = "needs_recovery";
        await writeManifest(transaction.manifestPath, manifest);
        return {
          ok: false,
          error: {
            code: "recovery_required",
            paths: manifest.files.map((file) => file.path),
            transactionId,
            recoveredTransactionIds,
          },
        };
      }
    }
    for (const guard of options.guards) {
      const committedEntry = manifest.files.find((candidate) => candidate.path === guard.path);
      const current = snapshotPath(options.rootPath, guard.path);
      if (committedEntry?.committed) {
        if (
          current.revision.status !== "regular" ||
          current.revision.sha256 !== committedEntry.installedSha256 ||
          current.revision.size !== committedEntry.installedSize
        ) {
          manifest.phase = "needs_recovery";
          await writeManifest(transaction.manifestPath, manifest);
          return {
            ok: false,
            error: {
              code: "recovery_required",
              paths: [guard.path],
              transactionId,
              recoveredTransactionIds,
            },
          };
        }
      } else if (!snapshotRevisionMatches(current.revision, guard.expected)) {
        manifest.phase = "needs_recovery";
        await writeManifest(transaction.manifestPath, manifest);
        return {
          ok: false,
          error: {
            code: "recovery_required",
            paths: [guard.path],
            transactionId,
            recoveredTransactionIds,
          },
        };
      }
    }
    manifest.phase = "committed";
    await writeManifest(transaction.manifestPath, manifest);
    await removeTransactionDirectory(transaction.directoryPath);
    return {
      ok: true,
      transactionId,
      changedPaths: options.writes.map((write) => write.path),
      recoveredTransactionIds,
    };
  } catch {
    manifest.phase = "needs_recovery";
    try {
      await writeManifest(transaction.manifestPath, manifest);
    } catch {
      // The original error remains the best available evidence; the next call
      // will report a recovery-required state if the manifest is unreadable.
    }
    return {
      ok: false,
      error: {
        code: "write_failed",
        paths: manifest.files.filter((file) => file.committed).map((file) => file.path),
        transactionId,
        recoveredTransactionIds,
      },
    };
  }
}

export async function applyProjectHarnessFileTransaction(
  options: ProjectHarnessTransactionOptions,
): Promise<ProjectHarnessTransactionResult> {
  return withProjectHarnessTransactionLock(options.rootPath, () =>
    applyProjectHarnessFileTransactionUnlocked(options),
  );
}
