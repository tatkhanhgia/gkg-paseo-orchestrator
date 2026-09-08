import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Read-only inspection of the two instruction entrypoints a project may route a
 * Project Harness index through. This module never writes; it only classifies
 * current bytes so a caller can decide a safe bootstrap/update action.
 */

export const HARNESS_MANAGED_BLOCK_BEGIN = "<!-- PASEO_HARNESS:BEGIN -->";
export const HARNESS_MANAGED_BLOCK_END = "<!-- PASEO_HARNESS:END -->";

const MANAGED_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(HARNESS_MANAGED_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(HARNESS_MANAGED_BLOCK_END)}`,
  "u",
);

/** A `HARNESS:BEGIN`-shaped marker not owned by this managed block, e.g. `.harness-core`. */
const FOREIGN_HARNESS_MARKER_PATTERN = /(?<!PASEO_)HARNESS:BEGIN/u;

export const ENTRYPOINT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export type EntrypointFileName = (typeof ENTRYPOINT_FILE_NAMES)[number];

export interface EntrypointFileSnapshot {
  fileName: EntrypointFileName;
  path: string;
  status: "missing" | "regular" | "symlink" | "unreadable";
  /** Raw, unresolved target as stored on disk; only present when `status` is `symlink`. */
  symlinkTarget?: string;
  /** Absolute path the raw target names, without following it; only present when `status` is `symlink`. */
  symlinkResolvedPath?: string;
  /** Whether the link chain terminates in a readable regular file (no loop, no missing target). */
  symlinkReachable?: boolean;
  /** File content; only present when `status` is `regular`. */
  content?: string;
  hasManagedHarnessBlock: boolean;
  hasForeignHarnessMarker: boolean;
}

export type EntrypointRelationship =
  | { kind: "agents_symlinks_to_claude" }
  | { kind: "claude_symlinks_to_agents" }
  | { kind: "circular_symlinks" }
  | { kind: "independent_regular_files" }
  | { kind: "single_regular_file"; which: EntrypointFileName }
  | { kind: "both_missing" }
  | { kind: "broken_symlink"; which: EntrypointFileName }
  | { kind: "symlink_points_elsewhere"; which: EntrypointFileName; resolvedTarget: string }
  | { kind: "unresolved" };

export interface HarnessEntrypointSnapshot {
  repoRoot: string;
  agents: EntrypointFileSnapshot;
  claude: EntrypointFileSnapshot;
  relationship: EntrypointRelationship;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resolveSymlinkTarget(repoRoot: string, rawTarget: string): string {
  return isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(repoRoot, rawTarget);
}

function inspectEntrypointFile(
  repoRoot: string,
  fileName: EntrypointFileName,
): EntrypointFileSnapshot {
  const path = join(repoRoot, fileName);
  let lstat: ReturnType<typeof lstatSync>;
  try {
    lstat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        fileName,
        path,
        status: "missing",
        hasManagedHarnessBlock: false,
        hasForeignHarnessMarker: false,
      };
    }
    return {
      fileName,
      path,
      status: "unreadable",
      hasManagedHarnessBlock: false,
      hasForeignHarnessMarker: false,
    };
  }

  if (lstat.isSymbolicLink()) {
    let symlinkTarget: string;
    try {
      symlinkTarget = readlinkSync(path);
    } catch {
      return {
        fileName,
        path,
        status: "unreadable",
        hasManagedHarnessBlock: false,
        hasForeignHarnessMarker: false,
      };
    }
    const symlinkResolvedPath = resolveSymlinkTarget(repoRoot, symlinkTarget);
    // `statSync` follows the full link chain using the OS resolver: it fails closed
    // (ENOENT/ELOOP) for a missing target or a symlink cycle, so a target that is
    // literally the sibling filename but unreachable is never reported as healthy.
    let symlinkReachable = false;
    try {
      symlinkReachable = statSync(path).isFile();
    } catch {
      symlinkReachable = false;
    }
    return {
      fileName,
      path,
      status: "symlink",
      symlinkTarget,
      symlinkResolvedPath,
      symlinkReachable,
      hasManagedHarnessBlock: false,
      hasForeignHarnessMarker: false,
    };
  }

  if (!lstat.isFile()) {
    // Directory, FIFO, socket, device, etc: refuse a synchronous content read of a
    // non-regular node rather than blocking or throwing mid-inspection.
    return {
      fileName,
      path,
      status: "unreadable",
      hasManagedHarnessBlock: false,
      hasForeignHarnessMarker: false,
    };
  }

  try {
    const content = readFileSync(path, "utf8");
    return {
      fileName,
      path,
      status: "regular",
      content,
      hasManagedHarnessBlock: MANAGED_BLOCK_PATTERN.test(content),
      hasForeignHarnessMarker: FOREIGN_HARNESS_MARKER_PATTERN.test(content),
    };
  } catch {
    return {
      fileName,
      path,
      status: "unreadable",
      hasManagedHarnessBlock: false,
      hasForeignHarnessMarker: false,
    };
  }
}

function isCircularPair(
  agentsPath: string,
  claudePath: string,
  agents: EntrypointFileSnapshot,
  claude: EntrypointFileSnapshot,
): boolean {
  return (
    agents.status === "symlink" &&
    claude.status === "symlink" &&
    agents.symlinkResolvedPath === claudePath &&
    claude.symlinkResolvedPath === agentsPath
  );
}

function classifySymlink(
  snapshot: EntrypointFileSnapshot,
  siblingKind: "agents_symlinks_to_claude" | "claude_symlinks_to_agents",
  siblingPath: string,
): EntrypointRelationship {
  const targetsSibling = snapshot.symlinkResolvedPath === siblingPath;
  if (targetsSibling && snapshot.symlinkReachable) return { kind: siblingKind };
  if (!snapshot.symlinkReachable) return { kind: "broken_symlink", which: snapshot.fileName };
  return {
    kind: "symlink_points_elsewhere",
    which: snapshot.fileName,
    resolvedTarget: snapshot.symlinkResolvedPath ?? snapshot.symlinkTarget ?? "",
  };
}

function classifyRelationship(
  repoRoot: string,
  agents: EntrypointFileSnapshot,
  claude: EntrypointFileSnapshot,
): EntrypointRelationship {
  const agentsPath = join(repoRoot, "AGENTS.md");
  const claudePath = join(repoRoot, "CLAUDE.md");

  if (isCircularPair(agentsPath, claudePath, agents, claude)) {
    return { kind: "circular_symlinks" };
  }
  if (agents.status === "symlink") {
    return classifySymlink(agents, "agents_symlinks_to_claude", claudePath);
  }
  if (claude.status === "symlink") {
    return classifySymlink(claude, "claude_symlinks_to_agents", agentsPath);
  }
  if (agents.status === "regular" && claude.status === "regular") {
    return { kind: "independent_regular_files" };
  }
  if (agents.status === "regular" && claude.status === "missing") {
    return { kind: "single_regular_file", which: "AGENTS.md" };
  }
  if (claude.status === "regular" && agents.status === "missing") {
    return { kind: "single_regular_file", which: "CLAUDE.md" };
  }
  if (agents.status === "missing" && claude.status === "missing") {
    return { kind: "both_missing" };
  }
  return { kind: "unresolved" };
}

export function inspectHarnessEntrypoints(repoRoot: string): HarnessEntrypointSnapshot {
  const agents = inspectEntrypointFile(repoRoot, "AGENTS.md");
  const claude = inspectEntrypointFile(repoRoot, "CLAUDE.md");
  return { repoRoot, agents, claude, relationship: classifyRelationship(repoRoot, agents, claude) };
}

export type EntrypointMigrationAction =
  | { fileName: EntrypointFileName; action: "none_already_managed" }
  | { fileName: EntrypointFileName; action: "none_routes_via_symlink" }
  | { fileName: EntrypointFileName; action: "insert_managed_block" }
  | { fileName: EntrypointFileName; action: "create_with_managed_block_only" }
  | { fileName: EntrypointFileName; action: "manual_reconciliation_required"; reason: string }
  | { fileName: EntrypointFileName; action: "unreadable_skip" };

export interface HarnessEntrypointMigrationPreview {
  repoRoot: string;
  actions: EntrypointMigrationAction[];
}

function previewForFile(
  snapshot: EntrypointFileSnapshot,
  routesViaSymlink: boolean,
  foreignOwnershipReason: string | undefined,
): EntrypointMigrationAction {
  const fileName = snapshot.fileName;
  if (snapshot.status === "unreadable") return { fileName, action: "unreadable_skip" };
  // A caller-supplied foreign-manifest ownership claim outranks marker inference: a
  // foreign harness can own a file without ever writing a HARNESS:BEGIN marker into it.
  if (foreignOwnershipReason) {
    return { fileName, action: "manual_reconciliation_required", reason: foreignOwnershipReason };
  }
  if (routesViaSymlink) return { fileName, action: "none_routes_via_symlink" };
  if (snapshot.status === "symlink") {
    return {
      fileName,
      action: "manual_reconciliation_required",
      reason: "symlink target is neither missing nor the sibling entrypoint",
    };
  }
  if (snapshot.status === "regular" && snapshot.hasForeignHarnessMarker) {
    return {
      fileName,
      action: "manual_reconciliation_required",
      reason:
        "existing non-Paseo HARNESS:BEGIN marker found; requires owner reconciliation before a managed block can be added",
    };
  }
  if (snapshot.status === "regular" && snapshot.hasManagedHarnessBlock) {
    return { fileName, action: "none_already_managed" };
  }
  if (snapshot.status === "regular") return { fileName, action: "insert_managed_block" };
  return { fileName, action: "create_with_managed_block_only" };
}

/**
 * Computes, without writing anything, what a bootstrap/update pass would do to
 * each entrypoint. A caller with an actual write lease applies these actions;
 * this function only classifies current bytes into a safe action set.
 *
 * `foreignOwnership` lets a caller inject ownership evidence this module cannot
 * see on its own (e.g. a foreign harness's own manifest listing `AGENTS.md` as
 * owned even though it never wrote a `HARNESS:BEGIN` marker into the file).
 */
export function buildHarnessEntrypointMigrationPreview(
  snapshot: HarnessEntrypointSnapshot,
  options?: { foreignOwnership?: ReadonlyMap<EntrypointFileName, string> },
): HarnessEntrypointMigrationPreview {
  const agentsRoutesViaSymlink = snapshot.relationship.kind === "agents_symlinks_to_claude";
  const claudeRoutesViaSymlink = snapshot.relationship.kind === "claude_symlinks_to_agents";
  const foreignOwnership = options?.foreignOwnership;
  return {
    repoRoot: snapshot.repoRoot,
    actions: [
      previewForFile(snapshot.agents, agentsRoutesViaSymlink, foreignOwnership?.get("AGENTS.md")),
      previewForFile(snapshot.claude, claudeRoutesViaSymlink, foreignOwnership?.get("CLAUDE.md")),
    ],
  };
}

/**
 * Wraps Foundation-authored entrypoint-block body content in the managed marker
 * pair. This module never authors the body prose itself — the body comes from
 * the harness package descriptor's `entrypointBlock` resource once wired, so
 * there is exactly one source of the routing text.
 */
export function buildManagedHarnessBlock(entrypointBlockContent: string): string {
  const body = entrypointBlockContent.trim();
  return `${HARNESS_MANAGED_BLOCK_BEGIN}\n${body}\n${HARNESS_MANAGED_BLOCK_END}`;
}
