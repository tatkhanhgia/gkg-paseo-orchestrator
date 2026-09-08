import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Bounded read/write primitive for a durable, project-scoped Supervisor
 * notebook file. This is the write/readback engine: expected-revision
 * compare-and-swap, one-designated-writer enforcement, and repo-containment
 * path safety. The server project notebook tools are the bounded authority
 * surface; callers still need a durable notebook grant.
 */

export interface ProjectNotebookRevision {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export type ProjectNotebookSnapshot =
  | { status: "missing"; repoRoot: string; path: string; revision: null }
  | {
      status: "valid";
      repoRoot: string;
      path: string;
      content: string;
      revision: ProjectNotebookRevision;
    }
  | { status: "unreadable"; repoRoot: string; path: string; revision: null };

export type ProjectNotebookWriteResult =
  | { ok: true; snapshot: ProjectNotebookSnapshot & { status: "valid" } }
  | {
      ok: false;
      error:
        | { code: "invalid_path"; reason: string }
        | { code: "not_designated_writer" }
        | { code: "stale_notebook"; current: ProjectNotebookSnapshot }
        | { code: "write_failed" };
    };

class PathSafetyError extends Error {}

/**
 * Finds the nearest existing ancestor of `path` (walking up from `path`
 * itself) and returns its real, symlink-resolved path together with the
 * remaining lexical suffix. Used so containment can be verified against the
 * real filesystem even when the final path component does not exist yet
 * (e.g. a notebook file being created for the first time).
 */
function nearestExistingRealAncestor(path: string): { realAncestor: string; suffix: string[] } {
  const suffix: string[] = [];
  let candidate = path;
  for (;;) {
    try {
      return { realAncestor: realpathSync(candidate), suffix };
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new PathSafetyError(`no existing ancestor found for path: ${path}`);
      }
      suffix.unshift(candidate.slice(parent.length + 1));
      candidate = parent;
    }
  }
}

/**
 * Resolves `relativePath` against `repoRoot` and verifies containment on the
 * REAL filesystem, not just lexically: an intermediate directory component
 * (e.g. `docs` or `docs/harness`) could itself be a symlink pointing outside
 * `repoRoot`, which a purely lexical `resolve()` + `startsWith()` check
 * cannot detect. The nearest existing ancestor is real-path resolved and
 * checked for containment within the real-path-resolved `repoRoot`.
 *
 * Returns the original LEXICAL path (not the real, symlink-resolved one) so
 * that a symlink at the leaf itself is still visible to the caller's own
 * `isSymbolicLink` check — the ancestor check here only rules out an escape
 * happening one or more directories above the notebook file, it does not
 * relax the existing "the notebook path itself must not be a symlink" rule.
 */
function resolveContainedPath(repoRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new PathSafetyError("relativePath must be relative, not absolute");
  }
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new PathSafetyError("relativePath escapes repoRoot");
  }

  if (resolvedPath === resolvedRoot) return resolvedPath;

  const realRoot = realpathSync(resolvedRoot);
  // Ancestor-only: check containment of the leaf's PARENT directory so an
  // as-yet-nonexistent leaf (first notebook write) never fails here, while a
  // symlinked ancestor still cannot smuggle the leaf outside repoRoot.
  const { realAncestor } = nearestExistingRealAncestor(dirname(resolvedPath));
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    throw new PathSafetyError("relativePath escapes repoRoot via a symlinked ancestor");
  }
  return resolvedPath;
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function revisionFor(path: string, content: string): ProjectNotebookRevision {
  const stats = statSync(path);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function inspectProjectNotebook(
  repoRoot: string,
  relativePath: string,
): ProjectNotebookSnapshot {
  let path: string;
  try {
    path = resolveContainedPath(repoRoot, relativePath);
  } catch {
    return { status: "unreadable", repoRoot, path: relativePath, revision: null };
  }
  if (isSymbolicLink(path)) {
    return { status: "unreadable", repoRoot, path, revision: null };
  }
  try {
    const content = readFileSync(path, "utf8");
    return { status: "valid", repoRoot, path, content, revision: revisionFor(path, content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", repoRoot, path, revision: null };
    }
    return { status: "unreadable", repoRoot, path, revision: null };
  }
}

function snapshotRevision(snapshot: ProjectNotebookSnapshot): ProjectNotebookRevision | null {
  return snapshot.status === "valid" ? snapshot.revision : null;
}

function revisionMatches(
  left: ProjectNotebookRevision | null,
  right: ProjectNotebookRevision | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs && left.size === right.size && left.sha256 === right.sha256;
}

function removeTemporaryFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Preserve the original write result; temp cleanup is best effort.
  }
}

/**
 * Writes the notebook with expected-revision compare-and-swap, refusing the
 * write unless `callerId` is the single `designatedWriterId` for this
 * notebook binding. Content is caller-composed (append the new causal record
 * before calling this); this function does not merge or interpret content.
 */
export function writeProjectNotebook(input: {
  repoRoot: string;
  relativePath: string;
  content: string;
  expectedRevision: ProjectNotebookRevision | null;
  callerId: string;
  designatedWriterId: string;
}): ProjectNotebookWriteResult {
  let path: string;
  try {
    path = resolveContainedPath(input.repoRoot, input.relativePath);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_path",
        reason: error instanceof Error ? error.message : "unsafe path",
      },
    };
  }
  if (input.callerId !== input.designatedWriterId) {
    return { ok: false, error: { code: "not_designated_writer" } };
  }

  const normalizedContent = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const current = inspectProjectNotebook(input.repoRoot, input.relativePath);
    if (!revisionMatches(snapshotRevision(current), input.expectedRevision)) {
      return { ok: false, error: { code: "stale_notebook", current } };
    }
    if (current.status === "unreadable" || isSymbolicLink(path)) {
      return { ok: false, error: { code: "write_failed" } };
    }

    // resolveContainedPath already verified the nearest existing ancestor of
    // dirname(path) is contained within repoRoot, so creating any missing
    // intermediate directories along that same lexical path cannot escape it.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, normalizedContent, { encoding: "utf8", mode: 0o644 });
    if (current.status === "valid") {
      chmodSync(tempPath, statSync(path).mode & 0o777);
    }
    renameSync(tempPath, path);

    const snapshot = inspectProjectNotebook(input.repoRoot, input.relativePath);
    if (snapshot.status !== "valid") return { ok: false, error: { code: "write_failed" } };
    return { ok: true, snapshot };
  } catch {
    removeTemporaryFile(tempPath);
    return { ok: false, error: { code: "write_failed" } };
  }
}

/**
 * Narrow record-append operation: the new content is required to begin with
 * the notebook's entire current content (read at call time, then verified
 * again under the same expected-revision compare-and-swap `writeProjectNotebook`
 * already uses). This is what the notebook contract in
 * `SUPERVISOR_NOTEBOOK.EMPTY.md` calls "preserve disproof/history" — a
 * whole-content overwrite that drops or rewrites any existing record is
 * rejected before it ever reaches disk, rather than trusted to the caller's
 * discipline. Use this instead of `writeProjectNotebook` for every record
 * addition; `writeProjectNotebook` remains only for the one-time bootstrap
 * write from an empty template into a `missing` notebook.
 */
export function appendProjectNotebookRecord(input: {
  repoRoot: string;
  relativePath: string;
  recordContent: string;
  callerId: string;
  designatedWriterId: string;
  /**
   * The revision the caller last observed (from `inspectProjectNotebook` /
   * `read_project_notebook`), or `null` if the caller last observed it
   * missing. When provided, this is what the CAS check runs against — a
   * caller that read a stale snapshot and appends anyway is rejected with
   * `stale_notebook` even though this function always re-reads the current
   * content to build `nextContent`. Omitted only for internal callers that
   * intentionally always want "append to whatever is there right now".
   */
  expectedRevision?: ProjectNotebookRevision | null;
}): ProjectNotebookWriteResult {
  const current = inspectProjectNotebook(input.repoRoot, input.relativePath);
  const currentContent = current.status === "valid" ? current.content : "";
  const separator = currentContent.length === 0 || currentContent.endsWith("\n") ? "" : "\n";
  const nextContent = `${currentContent}${separator}${input.recordContent}`;

  return writeProjectNotebook({
    repoRoot: input.repoRoot,
    relativePath: input.relativePath,
    content: nextContent,
    expectedRevision:
      input.expectedRevision !== undefined ? input.expectedRevision : snapshotRevision(current),
    callerId: input.callerId,
    designatedWriterId: input.designatedWriterId,
  });
}
