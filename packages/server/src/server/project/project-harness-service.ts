import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { HarnessPackageDescriptor } from "../policy/bundled/slp/harness-package-policy.js";
import {
  buildHarnessPackageArtifactDescriptor,
  loadHarnessPackageDescriptor,
} from "../policy/bundled/slp/harness-package-policy.js";
import {
  DEFAULT_HARNESS_ENTRY_MAP_PATH,
  DEFAULT_HARNESS_PROJECT_METADATA_PATH,
  DEFAULT_SUPERVISOR_NOTEBOOK_PATH,
} from "./harness-bootstrap-defaults.js";
import {
  inspectHarnessProjectMetadata,
  type HarnessProjectMetadata,
  type HarnessProjectMetadataSnapshot,
  type ProjectHarnessInstallation,
} from "./harness-project-metadata-file.js";
import {
  buildHarnessEntrypointMigrationPreview,
  buildManagedHarnessBlock,
  HARNESS_MANAGED_BLOCK_BEGIN,
  HARNESS_MANAGED_BLOCK_END,
  inspectHarnessEntrypoints,
  type EntrypointFileName,
} from "../../utils/harness-entrypoint-inspect.js";
import { renderHarnessTemplate } from "../../utils/harness-template-render.js";
import {
  applyProjectHarnessFileTransaction,
  inspectProjectHarnessFile,
  inspectProjectHarnessTransactions,
  recoverProjectHarnessTransactions,
  type ProjectHarnessTransactionGuard,
  type ProjectHarnessTransactionWrite,
} from "../../utils/project-harness-file-transaction.js";
import type {
  ProjectHarnessChange,
  ProjectHarnessFileRevision,
  ProjectHarnessFileSnapshot,
  ProjectHarnessInspection,
  ProjectHarnessForeignOwnership,
  ProjectHarnessOperation,
  ProjectHarnessPlan,
  ProjectHarnessProvenance,
  ProjectHarnessMutationResult,
  ProjectHarnessTarget,
} from "@getpaseo/protocol/project-harness/rpc-schemas";

const MANAGED_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(HARNESS_MANAGED_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(HARNESS_MANAGED_BLOCK_END)}`,
  "u",
);
const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/gu;
const FOREIGN_MANIFEST_PATH = ".harness-core/manifest.json";
const MAX_ANCESTOR_LEVELS = 6;
const MAX_NESTED_DIRECTORIES = 16;

export interface ProjectHarnessService {
  inspect(target: ProjectHarnessTarget): Promise<ProjectHarnessInspection>;
  preview(
    target: ProjectHarnessTarget,
    operation: ProjectHarnessOperation,
  ): Promise<ProjectHarnessPreviewResult>;
  apply(
    target: ProjectHarnessTarget,
    plan: ProjectHarnessPlan,
  ): Promise<ProjectHarnessMutationResult>;
  update(
    target: ProjectHarnessTarget,
    plan: ProjectHarnessPlan,
  ): Promise<ProjectHarnessMutationResult>;
}

export interface ProjectHarnessPreviewResult {
  inspection: ProjectHarnessInspection;
  plan: ProjectHarnessPlan;
  changes: ProjectHarnessChange[];
  readyToApply: boolean;
}

export class ProjectHarnessServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly paths: string[] = [],
  ) {
    super(message);
    this.name = "ProjectHarnessServiceError";
  }
}

interface ForeignOwnershipResult {
  status: "absent" | "valid" | "corrupt" | "unreadable";
  ownedPaths: string[];
  protectedPaths: string[];
  entries: ProjectHarnessForeignOwnership["entries"];
  reason?: string;
  ownedPathSet: ReadonlySet<string>;
}

export interface ProjectHarnessServiceOptions {
  descriptor?: HarnessPackageDescriptor;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function plannedRevision(content: string): ProjectHarnessFileRevision {
  return {
    status: "regular",
    mtimeMs: null,
    size: Buffer.byteLength(content),
    sha256: sha256(Buffer.from(content)),
  };
}

function fileSnapshot(rootPath: string, relativePath: string): ProjectHarnessFileSnapshot {
  return inspectProjectHarnessFile(rootPath, relativePath);
}

function revisionForDescriptorResource(path: string): {
  status: "regular" | "unreadable";
  revision: ProjectHarnessFileRevision;
} {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return {
        status: "unreadable",
        revision: { status: "unreadable", mtimeMs: null, size: null, sha256: null },
      };
    }
    const bytes = readFileSync(path);
    return {
      status: "regular",
      revision: {
        status: "regular",
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        sha256: sha256(bytes),
      },
    };
  } catch {
    return {
      status: "unreadable",
      revision: { status: "unreadable", mtimeMs: null, size: null, sha256: null },
    };
  }
}

function normalizeManifestPath(rootPath: string, value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  const absolute = resolve(rootPath, normalized);
  const relativePath = relative(resolve(rootPath), absolute).split(sep).join("/");
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith("../")) {
    return null;
  }
  return relativePath;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function foreignManifestFiles(
  value: Record<string, unknown>,
): Array<{ path: string; upstreamSha256: string }> | null {
  if (value.schema_version !== 1 || typeof value.core_version !== "string") return null;
  if (!Array.isArray(value.files) || value.files.length > 128) return null;
  const files: Array<{ path: string; upstreamSha256: string }> = [];
  for (const item of value.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !isSha256(file.upstream_sha256)) return null;
    files.push({ path: file.path, upstreamSha256: file.upstream_sha256 });
  }
  if (files.length === 0) return null;
  return files;
}

function foreignOwnershipEntries(
  rootPath: string,
  files: Array<{ path: string; upstreamSha256: string }>,
): ProjectHarnessForeignOwnership["entries"] | null {
  const entries: ProjectHarnessForeignOwnership["entries"] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = normalizeManifestPath(rootPath, file.path);
    if (!path || seen.has(path)) return null;
    seen.add(path);
    const current = inspectProjectHarnessFile(rootPath, path).revision;
    let drift: "unchanged" | "local_delta" | "missing" | "unreadable";
    if (current.status === "missing") drift = "missing";
    else if (current.status === "unreadable") drift = "unreadable";
    else if (current.status === "regular" && current.sha256 === file.upstreamSha256) {
      drift = "unchanged";
    } else {
      drift = "local_delta";
    }
    entries.push({
      path,
      upstreamSha256: file.upstreamSha256,
      status: current.status,
      currentSha256: current.sha256,
      drift,
    });
  }
  return entries;
}

function readForeignOwnership(rootPath: string): ForeignOwnershipResult {
  const manifest = inspectProjectHarnessFile(rootPath, FOREIGN_MANIFEST_PATH);
  if (manifest.revision.status === "missing") {
    return {
      status: "absent",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
      ownedPathSet: new Set(),
    };
  }
  if (manifest.revision.status !== "regular" || manifest.content === undefined) {
    return {
      status: "unreadable",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
      reason: "foreign ownership manifest is not a readable regular file",
      ownedPathSet: new Set(),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.content);
  } catch {
    return {
      status: "corrupt",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
      reason: "foreign ownership manifest is not valid JSON",
      ownedPathSet: new Set(),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "corrupt",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
      reason: "foreign ownership manifest root is not an object",
      ownedPathSet: new Set(),
    };
  }
  const object = parsed as Record<string, unknown>;
  const files = foreignManifestFiles(object);
  if (!files) {
    return {
      status: "corrupt",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
      reason:
        "foreign ownership manifest must be schema_version 1 with files[path, upstream_sha256]",
      ownedPathSet: new Set(),
    };
  }
  const entries = foreignOwnershipEntries(rootPath, files);
  if (!entries) {
    return {
      status: "corrupt",
      ownedPaths: [],
      protectedPaths: [],
      entries: [],
      reason: "foreign ownership manifest contains duplicate or unsafe paths",
      ownedPathSet: new Set(),
    };
  }
  const ownedPaths = entries.map((entry) => entry.path);
  const protectedPaths = [...ownedPaths];
  return {
    status: "valid",
    ownedPaths,
    protectedPaths,
    entries,
    ownedPathSet: new Set(ownedPaths),
  };
}

function foreignReasonForPath(
  path: string,
  ownership: ForeignOwnershipResult,
  marker: boolean,
): string | undefined {
  if (ownership.status === "corrupt" || ownership.status === "unreadable") {
    return ownership.reason ?? "foreign ownership manifest is unavailable";
  }
  if (ownership.ownedPathSet.has(path)) {
    const entry = ownership.entries.find((candidate) => candidate.path === path);
    return entry
      ? `foreign ownership manifest lists ${path}; current state is ${entry.drift}`
      : `foreign ownership manifest lists ${path}`;
  }
  if (marker) {
    return "existing non-Paseo HARNESS:BEGIN marker requires owner reconciliation";
  }
  return undefined;
}

function inProjectInstructionEvidence(
  relativePath: string,
  ownership: ForeignOwnershipResult,
  fallbackReason: string,
): { ownedBy: "foreign" | "unknown"; reason: string } {
  if (ownership.status === "valid" && ownership.ownedPathSet.has(relativePath)) {
    return {
      ownedBy: "foreign",
      reason: foreignReasonForPath(relativePath, ownership, false) ?? fallbackReason,
    };
  }
  return { ownedBy: "unknown", reason: fallbackReason };
}

function statusForVisibleInstruction(path: string): {
  status: "missing" | "regular" | "symlink" | "unreadable";
  readable: boolean;
} {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      try {
        return { status: "symlink", readable: statSync(path).isFile() };
      } catch {
        return { status: "symlink", readable: false };
      }
    }
    if (!stats.isFile()) return { status: "unreadable", readable: false };
    readFileSync(path, "utf8");
    return { status: "regular", readable: true };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing", readable: false }
      : { status: "unreadable", readable: false };
  }
}

function visibleInstructionEntry(
  path: string,
  scope: "ancestor" | "root" | "nested" | "override",
  ownedBy: "paseo" | "foreign" | "outside-project" | "unknown",
  reason?: string,
) {
  const result = statusForVisibleInstruction(path);
  return {
    path,
    scope,
    status: result.status,
    readable: result.readable,
    ownedBy,
    ...(reason ? { reason } : {}),
  };
}

function toWireEntrypointSnapshot(
  rootPath: string,
  entrypoint: ReturnType<typeof inspectHarnessEntrypoints>["agents"],
): ProjectHarnessInspection["entrypoints"][number] {
  const file = fileSnapshot(rootPath, entrypoint.fileName);
  const result: ProjectHarnessInspection["entrypoints"][number] = {
    fileName: entrypoint.fileName,
    path: entrypoint.path,
    status: entrypoint.status,
    revision: file.revision,
    hasManagedHarnessBlock: entrypoint.hasManagedHarnessBlock,
    hasForeignHarnessMarker: entrypoint.hasForeignHarnessMarker,
  };
  if (entrypoint.symlinkTarget) result.symlinkTarget = entrypoint.symlinkTarget;
  if (entrypoint.symlinkResolvedPath) result.symlinkResolvedPath = entrypoint.symlinkResolvedPath;
  if (entrypoint.symlinkReachable !== undefined) {
    result.symlinkReachable = entrypoint.symlinkReachable;
  }
  if (entrypoint.content !== undefined) result.content = entrypoint.content;
  return result;
}

// eslint-disable-next-line complexity -- bounded visibility deliberately records each unknown boundary.
function buildInstructionVisibility(
  rootPath: string,
  entrypoints: ReturnType<typeof inspectHarnessEntrypoints>,
  ownership: ForeignOwnershipResult,
) {
  const entrypointNames = ["AGENTS.md", "CLAUDE.md"] as const;
  const overrideNames = ["AGENTS.override.md", "CLAUDE.override.md"] as const;
  const localInstructionNames = ["CLAUDE.local.md"] as const;
  const entries: Array<{
    path: string;
    scope: "ancestor" | "root" | "nested" | "override";
    status: "missing" | "regular" | "symlink" | "unreadable" | "not_scanned";
    readable: boolean;
    ownedBy: "paseo" | "foreign" | "outside-project" | "unknown";
    reason?: string;
  }> = [];
  for (const snapshot of [entrypoints.agents, entrypoints.claude]) {
    const relativePath = snapshot.fileName;
    const hasForeignEvidence =
      snapshot.hasForeignHarnessMarker ||
      (ownership.status === "valid" && ownership.ownedPathSet.has(relativePath));
    const reason = hasForeignEvidence
      ? foreignReasonForPath(relativePath, ownership, snapshot.hasForeignHarnessMarker)
      : undefined;
    let ownedBy: "paseo" | "foreign" | "unknown" = "unknown";
    if (hasForeignEvidence) ownedBy = "foreign";
    else if (snapshot.hasManagedHarnessBlock) ownedBy = "paseo";
    entries.push(visibleInstructionEntry(snapshot.path, "root", ownedBy, reason));
  }
  for (const name of overrideNames) {
    const evidence = inProjectInstructionEvidence(
      name,
      ownership,
      "read-only bounded root additional-instruction observation; ownership and provider loading remain unknown",
    );
    entries.push(
      visibleInstructionEntry(join(rootPath, name), "override", evidence.ownedBy, evidence.reason),
    );
  }
  for (const name of localInstructionNames) {
    const evidence = inProjectInstructionEvidence(
      name,
      ownership,
      "read-only bounded documented local instruction path; ownership and provider loading remain unknown",
    );
    entries.push(
      visibleInstructionEntry(join(rootPath, name), "root", evidence.ownedBy, evidence.reason),
    );
  }
  const claudeProjectPath = ".claude/CLAUDE.md";
  const claudeProjectEvidence = inProjectInstructionEvidence(
    claudeProjectPath,
    ownership,
    "read-only bounded documented project instruction path; ownership and provider loading remain unknown",
  );
  entries.push(
    visibleInstructionEntry(
      join(rootPath, ".claude", "CLAUDE.md"),
      "nested",
      claudeProjectEvidence.ownedBy,
      claudeProjectEvidence.reason,
    ),
  );

  let ancestor = dirname(resolve(rootPath));
  let ancestorBounded = true;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    for (const name of entrypointNames) {
      entries.push(
        visibleInstructionEntry(
          join(ancestor, name),
          "ancestor",
          "outside-project",
          "read-only bounded ancestor observation; does not prove provider loading",
        ),
      );
    }
    for (const name of overrideNames) {
      entries.push(
        visibleInstructionEntry(
          join(ancestor, name),
          "override",
          "outside-project",
          "read-only bounded ancestor additional-instruction observation; ownership and provider loading remain unknown",
        ),
      );
    }
    for (const name of localInstructionNames) {
      entries.push(
        visibleInstructionEntry(
          join(ancestor, name),
          "ancestor",
          "outside-project",
          "read-only bounded documented local instruction path; ownership and provider loading remain unknown",
        ),
      );
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      ancestorBounded = false;
      break;
    }
    ancestor = parent;
  }
  if (ancestorBounded) {
    entries.push({
      path: join(ancestor, "<ancestor-instructions>").replaceAll(sep, "/"),
      scope: "ancestor",
      status: "not_scanned",
      readable: false,
      ownedBy: "outside-project",
      reason: `ancestor scan stopped after ${MAX_ANCESTOR_LEVELS} levels; remaining provider inputs are unknown`,
    });
  }

  let nestedDirectories: string[] = [];
  let nestedDirectoryOverflow = false;
  try {
    const discoveredDirectories = readdirSync(rootPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== ".git" &&
          entry.name !== "node_modules" &&
          entry.name !== ".claude",
      )
      .map((entry) => entry.name);
    nestedDirectoryOverflow = discoveredDirectories.length > MAX_NESTED_DIRECTORIES;
    nestedDirectories = discoveredDirectories.slice(0, MAX_NESTED_DIRECTORIES);
  } catch {
    entries.push({
      path: join(rootPath, "<nested-instructions>"),
      scope: "nested",
      status: "not_scanned",
      readable: false,
      ownedBy: "unknown",
      reason: "nested instruction directory listing was unreadable",
    });
  }
  for (const directory of nestedDirectories) {
    for (const name of entrypointNames) {
      const path = join(rootPath, directory, name);
      const status = statusForVisibleInstruction(path);
      if (status.status === "missing") continue;
      const relativePath = join(directory, name).replaceAll(sep, "/");
      const evidence = inProjectInstructionEvidence(
        relativePath,
        ownership,
        "read-only bounded nested instruction observation; ownership and provider loading remain unknown",
      );
      entries.push(visibleInstructionEntry(path, "nested", evidence.ownedBy, evidence.reason));
    }
    for (const name of overrideNames) {
      const path = join(rootPath, directory, name);
      const status = statusForVisibleInstruction(path);
      if (status.status === "missing") continue;
      const relativePath = join(directory, name).replaceAll(sep, "/");
      const evidence = inProjectInstructionEvidence(
        relativePath,
        ownership,
        "read-only bounded nested additional-instruction observation; ownership and provider loading remain unknown",
      );
      entries.push(visibleInstructionEntry(path, "override", evidence.ownedBy, evidence.reason));
    }
    const localPath = join(rootPath, directory, "CLAUDE.local.md");
    if (statusForVisibleInstruction(localPath).status !== "missing") {
      const relativePath = join(directory, "CLAUDE.local.md").replaceAll(sep, "/");
      const evidence = inProjectInstructionEvidence(
        relativePath,
        ownership,
        "read-only bounded documented local instruction path; ownership and provider loading remain unknown",
      );
      entries.push(visibleInstructionEntry(localPath, "nested", evidence.ownedBy, evidence.reason));
    }
  }
  if (nestedDirectoryOverflow) {
    entries.push({
      path: join(rootPath, "<nested-instructions>").replaceAll(sep, "/"),
      scope: "nested",
      status: "not_scanned",
      readable: false,
      ownedBy: "unknown",
      reason: `nested directory scan stopped after ${MAX_NESTED_DIRECTORIES} directories; remaining nested instruction files are unknown`,
    });
  }
  for (const name of [...entrypointNames, ...overrideNames]) {
    const path = join(rootPath, ".paseo", name);
    const status = statusForVisibleInstruction(path);
    if (status.status === "missing") continue;
    const relativePath = join(".paseo", name).replaceAll(sep, "/");
    const evidence = inProjectInstructionEvidence(
      relativePath,
      ownership,
      "read-only bounded Paseo additional-instruction observation; ownership and provider loading remain unknown",
    );
    entries.push(visibleInstructionEntry(path, "override", evidence.ownedBy, evidence.reason));
  }
  if (entries.length <= 64) return entries;
  return [
    ...entries.slice(0, 63),
    {
      path: join(rootPath, "<instruction-visibility>").replaceAll(sep, "/"),
      scope: "nested" as const,
      status: "not_scanned" as const,
      readable: false,
      ownedBy: "unknown" as const,
      reason:
        "instruction visibility output reached its 64-entry wire bound; omitted coverage is unknown",
    },
  ];
}

function metadataForWire(
  rootPath: string,
  metadata: HarnessProjectMetadataSnapshot,
): ProjectHarnessInspection["metadata"] {
  const file = fileSnapshot(rootPath, DEFAULT_HARNESS_PROJECT_METADATA_PATH);
  const projectHarness = metadata.status === "valid" ? metadata.metadata.projectHarness : undefined;
  return {
    path: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    status: metadata.status,
    revision: file.revision,
    ...(metadata.status === "valid" && metadata.metadata.supervisorNotebookIdentity
      ? { supervisorNotebookIdentity: metadata.metadata.supervisorNotebookIdentity }
      : {}),
    ...(metadata.status === "valid" && metadata.metadata.supervisorNotebook
      ? {
          supervisorNotebook: {
            notebookId: metadata.metadata.supervisorNotebook.notebookId,
            location: metadata.metadata.supervisorNotebook.location,
            designatedWriterId: metadata.metadata.supervisorNotebook.designatedWriterId,
            scope: metadata.metadata.supervisorNotebook.scope,
            expiresAt: metadata.metadata.supervisorNotebook.expiresAt,
          },
        }
      : {}),
    ...(projectHarness ? { projectHarness } : {}),
  };
}

function notebookLocationForMetadata(metadata: HarnessProjectMetadataSnapshot): {
  location: string;
  source: "default" | "custom";
} {
  if (metadata.status !== "valid") {
    return { location: DEFAULT_SUPERVISOR_NOTEBOOK_PATH, source: "default" };
  }
  const identity =
    metadata.metadata.supervisorNotebookIdentity ??
    (metadata.metadata.supervisorNotebook
      ? {
          notebookId: metadata.metadata.supervisorNotebook.notebookId,
          location: metadata.metadata.supervisorNotebook.location,
        }
      : undefined);
  return identity
    ? { location: identity.location, source: "custom" }
    : { location: DEFAULT_SUPERVISOR_NOTEBOOK_PATH, source: "default" };
}

function resourceSnapshot(
  key: "entryMap" | "entrypointBlock" | "supervisorNotebookTemplate",
  path: string,
  digest: string,
  projectSnapshot?: ProjectHarnessFileSnapshot,
) {
  const resource = projectSnapshot ?? {
    path,
    revision: revisionForDescriptorResource(path).revision,
  };
  let status: "missing" | "regular" | "unreadable";
  if (resource.revision.status === "missing") status = "missing";
  else if (resource.revision.status === "regular") status = "regular";
  else status = "unreadable";
  return { key, path, status, revision: resource.revision, digest };
}

function buildProvenance(descriptor: HarnessPackageDescriptor): ProjectHarnessProvenance {
  return buildHarnessPackageArtifactDescriptor(descriptor);
}

function contentDigest(content: string): string {
  return sha256(Buffer.from(content));
}

function managedBlockFromContent(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return content.match(MANAGED_BLOCK_PATTERN)?.[0];
}

function installationForProjectHarness(input: {
  descriptor: HarnessPackageDescriptor;
  entryMapSha256: string;
  entryMapManaged: boolean;
  managedEntrypoints: Partial<Record<EntrypointFileName, string>>;
}): ProjectHarnessInstallation {
  const managedEntrypoints: ProjectHarnessInstallation["managedEntrypoints"] = {};
  if (input.managedEntrypoints["AGENTS.md"] !== undefined) {
    managedEntrypoints["AGENTS.md"] = input.managedEntrypoints["AGENTS.md"];
  }
  if (input.managedEntrypoints["CLAUDE.md"] !== undefined) {
    managedEntrypoints["CLAUDE.md"] = input.managedEntrypoints["CLAUDE.md"];
  }
  return {
    package: input.descriptor.package,
    generation: input.descriptor.generation,
    artifactDigest: input.descriptor.artifactDigest,
    descriptorDigest: input.descriptor.descriptorDigest,
    entryMapSha256: input.entryMapSha256,
    entryMapManaged: input.entryMapManaged,
    managedEntrypoints,
  };
}

function metadataWithProjectHarness(
  metadata: HarnessProjectMetadataSnapshot,
  installation: ProjectHarnessInstallation,
): string {
  const base: HarnessProjectMetadata = metadata.status === "valid" ? metadata.metadata : {};
  return `${JSON.stringify({ ...base, projectHarness: installation }, null, 2)}\n`;
}

function installationMatches(
  left: ProjectHarnessInstallation | undefined,
  right: ProjectHarnessInstallation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateDescriptorTemplate(descriptor: HarnessPackageDescriptor): string {
  const content = readFileSync(descriptor.resourcePaths.entrypointBlock, "utf8");
  const tokens = Array.from(content.matchAll(TOKEN_PATTERN), (match) => match[1]);
  const declared: string[] = [...descriptor.entrypointPlaceholders];
  if (
    tokens.length !== 2 ||
    declared.length !== 2 ||
    new Set(tokens).size !== 2 ||
    !declared.every((token) => tokens.includes(token)) ||
    !tokens.every((token) => declared.includes(token))
  ) {
    throw new ProjectHarnessServiceError(
      "invalid_harness_resource",
      "Foundation entrypoint block must declare and use exactly two supported HARNESS tokens",
    );
  }
  return content;
}

function renderManagedBlock(
  rootPath: string,
  fileName: EntrypointFileName,
  template: string,
  entryMapContent: string,
): string {
  const workspaceProtocol = fileSnapshot(rootPath, "WORKSPACE_PROTOCOL.md");
  if (workspaceProtocol.revision.status !== "regular") {
    throw new ProjectHarnessServiceError(
      "workspace_protocol_unavailable",
      "WORKSPACE_PROTOCOL.md must be a readable regular file before Project Harness rendering",
      ["WORKSPACE_PROTOCOL.md"],
    );
  }

  // The renderer deliberately requires reachable targets. Preview is read-only,
  // so mirror the planned resource into an OS temp tree with the same project
  // relative layout; this keeps path computation identical without touching the
  // Product worktree.
  const renderRoot = mkdtempSync(join(tmpdir(), "paseo-project-harness-render-"));
  try {
    const entryMapPath = join(renderRoot, DEFAULT_HARNESS_ENTRY_MAP_PATH);
    const workspaceProtocolPath = join(renderRoot, "WORKSPACE_PROTOCOL.md");
    const outputFilePath = join(renderRoot, fileName);
    mkdirSync(dirname(entryMapPath), { recursive: true });
    requireWriteText(entryMapPath, entryMapContent);
    requireWriteText(workspaceProtocolPath, "WORKSPACE_PROTOCOL\n");
    const rendered = renderHarnessTemplate(template, {
      outputFilePath,
      entryMapPath,
      workspaceProtocolPath,
    }).trim();
    const managed = rendered.includes(HARNESS_MANAGED_BLOCK_BEGIN)
      ? rendered
      : buildManagedHarnessBlock(rendered);
    const beginCount = managed.split(HARNESS_MANAGED_BLOCK_BEGIN).length - 1;
    const endCount = managed.split(HARNESS_MANAGED_BLOCK_END).length - 1;
    if (beginCount !== 1 || endCount !== 1) {
      throw new ProjectHarnessServiceError(
        "invalid_harness_resource",
        "Foundation entrypoint block must contain exactly one managed marker pair",
      );
    }
    return managed;
  } finally {
    rmSync(renderRoot, { recursive: true, force: true });
  }
}

function requireWriteText(path: string, content: string): void {
  // Kept local so the read-only project preview only ever writes its disposable
  // renderer mirror, never a project target.
  writeFileSync(path, content, { encoding: "utf8", mode: 0o644 });
}

function insertManagedBlock(content: string, block: string): string {
  if (content.length === 0) return `${block}\n`;
  return `${block}\n\n${content}`;
}

function replaceManagedBlock(content: string, block: string): string {
  return content.replace(MANAGED_BLOCK_PATTERN, block);
}

function diffText(path: string, before: string | undefined, after: string): string | undefined {
  if (before === after) return undefined;
  const beforeLines = (before ?? "").split(/\r?\n/u);
  const afterLines = after.split(/\r?\n/u);
  return [
    `--- ${path}`,
    `+++ ${path}`,
    ...beforeLines.filter((line) => line.length > 0).map((line) => `-${line}`),
    ...afterLines.filter((line) => line.length > 0).map((line) => `+${line}`),
  ].join("\n");
}

function makeChange(input: {
  rootPath: string;
  path: string;
  action: ProjectHarnessChange["action"];
  afterContent?: string;
  reason?: string;
}): ProjectHarnessChange {
  const before = fileSnapshot(input.rootPath, input.path);
  let after: ProjectHarnessChange["after"];
  if (input.afterContent === undefined) {
    after = input.action === "preserve" ? before : null;
  } else {
    after = {
      path: input.path,
      revision: plannedRevision(input.afterContent),
      content: input.afterContent,
    };
  }
  return {
    path: input.path,
    action: input.action,
    before,
    after,
    ...(input.afterContent !== undefined
      ? { diff: diffText(input.path, before.content, input.afterContent) }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function canonicalPlanDigest(plan: Omit<ProjectHarnessPlan, "planDigest">): string {
  return sha256(JSON.stringify(plan));
}

function withPlanDigest(plan: Omit<ProjectHarnessPlan, "planDigest">): ProjectHarnessPlan {
  return { ...plan, planDigest: canonicalPlanDigest(plan) };
}

function planDigestMatches(plan: ProjectHarnessPlan): boolean {
  const { planDigest: _ignored, ...withoutDigest } = plan;
  return canonicalPlanDigest(withoutDigest) === plan.planDigest;
}

function targetMatches(left: ProjectHarnessTarget, right: ProjectHarnessTarget): boolean {
  return (
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.projectRoot === right.projectRoot &&
    left.workspaceRoot === right.workspaceRoot &&
    left.cwd === right.cwd
  );
}

function isForeignPath(path: string, ownership: ForeignOwnershipResult): boolean {
  return ownership.ownedPathSet.has(path);
}

function guardFor(
  inspection: ProjectHarnessInspection,
  path: string,
): ProjectHarnessTransactionGuard {
  const foreignManifestRevision: ProjectHarnessFileRevision =
    inspection.foreignOwnership.status === "absent"
      ? { status: "missing", mtimeMs: null, size: null, sha256: null }
      : inspectProjectHarnessFile(inspection.target.projectRoot, FOREIGN_MANIFEST_PATH).revision;
  const all = [
    ...inspection.entrypoints.map((entrypoint) => ({
      path: entrypoint.fileName,
      revision: entrypoint.revision,
    })),
    {
      path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
      revision: inspection.resources.find((resource) => resource.key === "entryMap")?.revision,
    },
    { path: DEFAULT_HARNESS_PROJECT_METADATA_PATH, revision: inspection.metadata.revision },
    { path: inspection.notebook.path, revision: inspection.notebook.revision },
    { path: "WORKSPACE_PROTOCOL.md", revision: inspection.workspaceProtocol.revision },
    {
      path: FOREIGN_MANIFEST_PATH,
      revision: foreignManifestRevision,
    },
  ];
  const found = all.find((candidate) => candidate.path === path);
  if (!found?.revision) {
    throw new ProjectHarnessServiceError("invalid_plan", `Missing guard revision for ${path}`, [
      path,
    ]);
  }
  return { path, expected: found.revision };
}

export function createProjectHarnessService(
  options: ProjectHarnessServiceOptions = {},
): ProjectHarnessService {
  const descriptor = options.descriptor ?? loadHarnessPackageDescriptor();
  const entrypointTemplate = validateDescriptorTemplate(descriptor);
  const provenance = buildProvenance(descriptor);
  const entryMapContent = readFileSync(descriptor.resourcePaths.entryMap, "utf8");
  const notebookTemplate = readFileSync(
    descriptor.resourcePaths.supervisorNotebookTemplate,
    "utf8",
  );

  async function inspect(target: ProjectHarnessTarget): Promise<ProjectHarnessInspection> {
    const transactionRecovery = await inspectProjectHarnessTransactions(target.projectRoot);
    const entrypointSnapshot = inspectHarnessEntrypoints(target.projectRoot);
    const metadataRaw = inspectHarnessProjectMetadata(
      target.projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    const notebookLocation = notebookLocationForMetadata(metadataRaw);
    const ownership = readForeignOwnership(target.projectRoot);
    const entryMap = fileSnapshot(target.projectRoot, DEFAULT_HARNESS_ENTRY_MAP_PATH);
    const notebook = fileSnapshot(target.projectRoot, notebookLocation.location);
    const workspaceProtocol = fileSnapshot(target.projectRoot, "WORKSPACE_PROTOCOL.md");
    const entrypoints = [
      toWireEntrypointSnapshot(target.projectRoot, entrypointSnapshot.agents),
      toWireEntrypointSnapshot(target.projectRoot, entrypointSnapshot.claude),
    ];
    const resourceBlock = revisionForDescriptorResource(descriptor.resourcePaths.entrypointBlock);
    const resourceNotebook = revisionForDescriptorResource(
      descriptor.resourcePaths.supervisorNotebookTemplate,
    );
    let recovery: ProjectHarnessInspection["recovery"];
    if (transactionRecovery.status === "blocked") {
      recovery = {
        status: "blocked",
        transactionIds: transactionRecovery.transactionIds,
        reason: transactionRecovery.reason,
      };
    } else if (transactionRecovery.status === "pending") {
      recovery = { status: "pending", transactionIds: transactionRecovery.transactionIds };
    } else {
      recovery = { status: "none", transactionIds: [] };
    }
    return {
      target,
      relationship: entrypointSnapshot.relationship,
      entrypoints,
      metadata: metadataForWire(target.projectRoot, metadataRaw),
      notebook: { ...notebook, source: notebookLocation.source },
      resources: [
        resourceSnapshot(
          "entryMap",
          DEFAULT_HARNESS_ENTRY_MAP_PATH,
          descriptor.resourceDigests.entryMap,
          entryMap,
        ),
        resourceSnapshot(
          "entrypointBlock",
          descriptor.resourcePaths.entrypointBlock,
          descriptor.resourceDigests.entrypointBlock,
          { path: descriptor.resourcePaths.entrypointBlock, revision: resourceBlock.revision },
        ),
        resourceSnapshot(
          "supervisorNotebookTemplate",
          descriptor.resourcePaths.supervisorNotebookTemplate,
          descriptor.resourceDigests.supervisorNotebookTemplate,
          {
            path: descriptor.resourcePaths.supervisorNotebookTemplate,
            revision: resourceNotebook.revision,
          },
        ),
      ],
      workspaceProtocol,
      foreignOwnership: {
        status: ownership.status,
        manifestPath: FOREIGN_MANIFEST_PATH,
        ownedPaths: ownership.ownedPaths,
        protectedPaths: ownership.protectedPaths,
        entries: ownership.entries,
        ...(ownership.reason ? { reason: ownership.reason } : {}),
      },
      instructionVisibility: buildInstructionVisibility(
        target.projectRoot,
        entrypointSnapshot,
        ownership,
      ),
      recovery,
      provenance,
    };
  }

  // eslint-disable-next-line complexity
  async function preview(
    target: ProjectHarnessTarget,
    operation: ProjectHarnessOperation,
  ): Promise<ProjectHarnessPreviewResult> {
    const inspection = await inspect(target);
    if (inspection.recovery.status !== "none") {
      throw new ProjectHarnessServiceError(
        "transaction_recovery_required",
        "Project Harness has an interrupted transaction; apply/update must recover it before preview",
        inspection.recovery.transactionIds,
      );
    }
    if (inspection.workspaceProtocol.revision.status !== "regular") {
      const isMissing = inspection.workspaceProtocol.revision.status === "missing";
      throw new ProjectHarnessServiceError(
        isMissing ? "workspace_protocol_required" : "workspace_protocol_unavailable",
        isMissing
          ? "Create WORKSPACE_PROTOCOL.md through foundation.workspaceProtocol.write.request with the registered project root and expected missing revision, then retry Project Harness inspect/preview; Project Harness does not author a generic WP template"
          : "WORKSPACE_PROTOCOL.md must be a readable regular file before Project Harness rendering",
        ["WORKSPACE_PROTOCOL.md"],
      );
    }
    if (
      inspection.metadata.status === "corrupt" ||
      inspection.metadata.status === "unreadable" ||
      inspection.metadata.revision.status === "symlink" ||
      inspection.metadata.revision.status === "unreadable"
    ) {
      throw new ProjectHarnessServiceError(
        "metadata_unreadable",
        "Project Harness metadata is not safely readable; preserve the existing claim and reconcile it first",
        [DEFAULT_HARNESS_PROJECT_METADATA_PATH],
      );
    }

    const changes: ProjectHarnessChange[] = [];
    const writes: ProjectHarnessTransactionWrite[] = [];
    const blockedReasons: string[] = [];
    const ownership = readForeignOwnership(target.projectRoot);
    if (ownership.status === "corrupt" || ownership.status === "unreadable") {
      changes.push(
        makeChange({
          rootPath: target.projectRoot,
          path: FOREIGN_MANIFEST_PATH,
          action: "blocked",
          reason: ownership.reason ?? "foreign ownership manifest is unavailable",
        }),
      );
      blockedReasons.push(FOREIGN_MANIFEST_PATH);
    }
    const metadataRaw = inspectHarnessProjectMetadata(
      target.projectRoot,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
    );
    const currentInstallation =
      metadataRaw.status === "valid" ? metadataRaw.metadata.projectHarness : undefined;
    const foreignEntrypointOwnership = new Map<EntrypointFileName, string>();
    for (const entrypoint of inspection.entrypoints) {
      const reason = foreignReasonForPath(
        entrypoint.fileName,
        ownership,
        entrypoint.hasForeignHarnessMarker,
      );
      if (reason) foreignEntrypointOwnership.set(entrypoint.fileName, reason);
    }
    const migration = buildHarnessEntrypointMigrationPreview(
      {
        repoRoot: target.projectRoot,
        agents: inspection.entrypoints[0],
        claude: inspection.entrypoints[1],
        relationship: inspection.relationship,
      },
      {
        foreignOwnership: foreignEntrypointOwnership,
      },
    );
    const entryMapSnapshot = fileSnapshot(target.projectRoot, DEFAULT_HARNESS_ENTRY_MAP_PATH);
    const desiredEntryMapSha256 = contentDigest(entryMapContent);
    let entryMapSha256 = currentInstallation?.entryMapSha256 ?? desiredEntryMapSha256;
    let entryMapManaged = currentInstallation?.entryMapManaged ?? false;
    let entryMapContentForRendering = entryMapSnapshot.content ?? entryMapContent;
    const nextManagedEntrypoints: Partial<Record<EntrypointFileName, string>> = {
      ...currentInstallation?.managedEntrypoints,
    };
    const addWrite = (
      path: string,
      content: string,
      reason?: string,
    ): "write" | "preserve" | "manual" | "blocked" => {
      const before = fileSnapshot(target.projectRoot, path);
      if (isForeignPath(path, ownership)) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path,
            action: "manual_reconciliation_required",
            reason: reason ?? `foreign ownership manifest lists ${path}`,
          }),
        );
        return "manual";
      }
      if (before.revision.status !== "missing" && before.revision.status !== "regular") {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path,
            action: "blocked",
            reason: `target is ${before.revision.status}, not a replaceable regular file`,
          }),
        );
        blockedReasons.push(path);
        return "blocked";
      }
      if (before.content === content) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path,
            action: "preserve",
            afterContent: content,
          }),
        );
        return "preserve";
      }
      writes.push({ path, expected: before.revision, content });
      changes.push(
        makeChange({
          rootPath: target.projectRoot,
          path,
          action: before.revision.status === "missing" ? "create" : "update",
          afterContent: content,
        }),
      );
      return "write";
    };

    if (entryMapSnapshot.revision.status === "missing") {
      if (operation === "update" && currentInstallation) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
            action: "blocked",
            reason: "Paseo-managed entry map was removed after bootstrap; reconcile before update",
          }),
        );
        blockedReasons.push(DEFAULT_HARNESS_ENTRY_MAP_PATH);
      } else if (isForeignPath(DEFAULT_HARNESS_ENTRY_MAP_PATH, ownership)) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
            action: "manual_reconciliation_required",
            reason: "foreign-owned entry map is absent; route cannot be validated",
          }),
        );
        blockedReasons.push(DEFAULT_HARNESS_ENTRY_MAP_PATH);
      } else {
        const outcome = addWrite(DEFAULT_HARNESS_ENTRY_MAP_PATH, entryMapContent);
        if (outcome === "write" || outcome === "preserve") {
          entryMapSha256 = desiredEntryMapSha256;
          entryMapManaged = true;
          entryMapContentForRendering = entryMapContent;
        }
      }
    } else if (entryMapSnapshot.revision.status === "regular") {
      const entryMapIsForeign = isForeignPath(DEFAULT_HARNESS_ENTRY_MAP_PATH, ownership);
      if (entryMapIsForeign) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
            action: "manual_reconciliation_required",
            afterContent: entryMapSnapshot.content,
            reason: "foreign-owned entry map is preserved without Paseo ownership",
          }),
        );
        entryMapSha256 = entryMapSnapshot.revision.sha256 ?? entryMapSha256;
        entryMapManaged = false;
      } else if (operation === "update" && currentInstallation?.entryMapManaged) {
        if (entryMapSnapshot.revision.sha256 !== currentInstallation.entryMapSha256) {
          changes.push(
            makeChange({
              rootPath: target.projectRoot,
              path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
              action: "blocked",
              reason: "Paseo-managed entry map has local drift; update refuses to overwrite it",
            }),
          );
          blockedReasons.push(DEFAULT_HARNESS_ENTRY_MAP_PATH);
        } else if (entryMapSnapshot.revision.sha256 === desiredEntryMapSha256) {
          changes.push(
            makeChange({
              rootPath: target.projectRoot,
              path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
              action: "preserve",
              afterContent: entryMapSnapshot.content,
            }),
          );
        } else {
          const outcome = addWrite(DEFAULT_HARNESS_ENTRY_MAP_PATH, entryMapContent);
          if (outcome === "write" || outcome === "preserve") {
            entryMapSha256 = desiredEntryMapSha256;
            entryMapContentForRendering = entryMapContent;
          }
        }
      } else {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
            action: "preserve",
            afterContent: entryMapSnapshot.content,
            reason:
              operation === "update"
                ? "entry map is not Paseo-owned; local payload is preserved"
                : undefined,
          }),
        );
        entryMapSha256 = entryMapSnapshot.revision.sha256 ?? entryMapSha256;
        entryMapManaged = false;
      }
    } else {
      changes.push(
        makeChange({
          rootPath: target.projectRoot,
          path: DEFAULT_HARNESS_ENTRY_MAP_PATH,
          action: "blocked",
          reason: `entry map target is ${entryMapSnapshot.revision.status}`,
        }),
      );
      blockedReasons.push(DEFAULT_HARNESS_ENTRY_MAP_PATH);
    }

    let nextInstallation: ProjectHarnessInstallation | undefined;
    if (operation === "bootstrap" && !currentInstallation) {
      nextInstallation = installationForProjectHarness({
        descriptor,
        entryMapSha256,
        entryMapManaged,
        managedEntrypoints: nextManagedEntrypoints,
      });
    } else if (currentInstallation) {
      nextInstallation = installationForProjectHarness({
        descriptor,
        entryMapSha256,
        entryMapManaged,
        managedEntrypoints: nextManagedEntrypoints,
      });
    } else {
      changes.push(
        makeChange({
          rootPath: target.projectRoot,
          path: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
          action: "blocked",
          reason: "update requires a bootstrap provenance record before managed bytes can change",
        }),
      );
      blockedReasons.push(DEFAULT_HARNESS_PROJECT_METADATA_PATH);
    }

    const notebookPath = inspection.notebook.path;
    if (inspection.notebook.revision.status === "missing") {
      if (operation === "update" && currentInstallation) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: notebookPath,
            action: "blocked",
            reason:
              "installed notebook is missing; update preserves notebook state and refuses recreation",
          }),
        );
        blockedReasons.push(notebookPath);
      } else {
        addWrite(notebookPath, notebookTemplate);
      }
    } else if (inspection.notebook.revision.status === "regular") {
      changes.push(
        makeChange({
          rootPath: target.projectRoot,
          path: notebookPath,
          action: "preserve",
          afterContent: inspection.notebook.content ?? "",
        }),
      );
    } else {
      changes.push(
        makeChange({
          rootPath: target.projectRoot,
          path: notebookPath,
          action: "blocked",
          reason: `notebook target is ${inspection.notebook.revision.status}`,
        }),
      );
      blockedReasons.push(notebookPath);
    }

    const renderedBlockByName = new Map<EntrypointFileName, string>();
    for (const entrypoint of inspection.entrypoints) {
      const rendered = renderManagedBlock(
        target.projectRoot,
        entrypoint.fileName,
        entrypointTemplate,
        entryMapContentForRendering,
      );
      renderedBlockByName.set(entrypoint.fileName, rendered);
    }
    for (const action of migration.actions) {
      const entrypoint = inspection.entrypoints.find(
        (candidate) => candidate.fileName === action.fileName,
      );
      if (!entrypoint) continue;
      if (action.action === "none_routes_via_symlink") {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: action.fileName,
            action: "preserve",
            afterContent: entrypoint.content,
            reason:
              "entrypoint routing symlink is preserved; its regular sibling target is handled separately",
          }),
        );
        continue;
      }
      const foreignReason = foreignEntrypointOwnership.get(action.fileName);
      if (action.action === "manual_reconciliation_required") {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: action.fileName,
            action: "manual_reconciliation_required",
            reason:
              foreignReason ??
              ("reason" in action ? action.reason : "entrypoint requires reconciliation"),
          }),
        );
        delete nextManagedEntrypoints[action.fileName];
        continue;
      }
      if (action.action === "unreadable_skip") {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: action.fileName,
            action: "blocked",
            reason: "entrypoint is unreadable",
          }),
        );
        blockedReasons.push(action.fileName);
        continue;
      }
      const block = renderedBlockByName.get(action.fileName);
      if (!block) continue;
      const content = entrypoint.content ?? "";
      const currentManagedBlock = managedBlockFromContent(content);
      const recordedManagedDigest = currentInstallation?.managedEntrypoints[action.fileName];
      const hasInstallation = currentInstallation !== undefined;
      if (action.action === "none_already_managed") {
        if (!currentManagedBlock) {
          blockedReasons.push(action.fileName);
          changes.push(
            makeChange({
              rootPath: target.projectRoot,
              path: action.fileName,
              action: "blocked",
              reason: "managed entrypoint marker was classified but its block could not be read",
            }),
          );
          continue;
        }
        if (!hasInstallation) {
          nextManagedEntrypoints[action.fileName] = contentDigest(currentManagedBlock);
          continue;
        }
        if (
          recordedManagedDigest === undefined ||
          contentDigest(currentManagedBlock) !== recordedManagedDigest
        ) {
          changes.push(
            makeChange({
              rootPath: target.projectRoot,
              path: action.fileName,
              action: "blocked",
              reason: "managed entrypoint block has local drift; update refuses to overwrite it",
            }),
          );
          blockedReasons.push(action.fileName);
          continue;
        }
        if (currentManagedBlock === block) {
          nextManagedEntrypoints[action.fileName] = contentDigest(currentManagedBlock);
          changes.push(
            makeChange({
              rootPath: target.projectRoot,
              path: action.fileName,
              action: "preserve",
              afterContent: entrypoint.content,
            }),
          );
          continue;
        }
        const desiredManagedContent = replaceManagedBlock(content, block);
        const outcome = addWrite(action.fileName, desiredManagedContent);
        if (outcome === "write" || outcome === "preserve") {
          nextManagedEntrypoints[action.fileName] = contentDigest(block);
        }
        continue;
      }
      if (operation === "update" && hasInstallation) {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: action.fileName,
            action: "blocked",
            reason:
              "managed entrypoint block is missing; update refuses to recreate deleted routing",
          }),
        );
        blockedReasons.push(action.fileName);
        continue;
      }
      let desired: string;
      if (action.action === "create_with_managed_block_only") {
        desired = `${block}\n`;
      } else if (action.action === "insert_managed_block") {
        desired = insertManagedBlock(content, block);
      } else {
        desired = replaceManagedBlock(content, block);
      }
      const outcome = addWrite(action.fileName, desired);
      if (outcome === "write" || outcome === "preserve") {
        nextManagedEntrypoints[action.fileName] = contentDigest(block);
      }
    }

    if (nextInstallation) {
      nextInstallation = installationForProjectHarness({
        descriptor,
        entryMapSha256,
        entryMapManaged,
        managedEntrypoints: nextManagedEntrypoints,
      });
      const metadataSnapshot = fileSnapshot(
        target.projectRoot,
        DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      );
      if (
        metadataRaw.status !== "valid" ||
        !installationMatches(metadataRaw.metadata.projectHarness, nextInstallation)
      ) {
        addWrite(
          DEFAULT_HARNESS_PROJECT_METADATA_PATH,
          metadataWithProjectHarness(metadataRaw, nextInstallation),
        );
      } else {
        changes.push(
          makeChange({
            rootPath: target.projectRoot,
            path: DEFAULT_HARNESS_PROJECT_METADATA_PATH,
            action: "preserve",
            afterContent: metadataSnapshot.content ?? "",
          }),
        );
      }
    }

    const guardPaths = [
      "AGENTS.md",
      "CLAUDE.md",
      DEFAULT_HARNESS_ENTRY_MAP_PATH,
      DEFAULT_HARNESS_PROJECT_METADATA_PATH,
      notebookPath,
      "WORKSPACE_PROTOCOL.md",
      FOREIGN_MANIFEST_PATH,
    ];
    const guards = guardPaths.map((path) => guardFor(inspection, path));
    const plan = withPlanDigest({ operation, target, provenance, guards, files: writes });
    return {
      inspection,
      plan,
      changes,
      readyToApply: blockedReasons.length === 0,
    };
  }

  async function mutate(
    target: ProjectHarnessTarget,
    plan: ProjectHarnessPlan,
    expectedOperation: ProjectHarnessOperation,
  ): Promise<ProjectHarnessMutationResult> {
    if (!planDigestMatches(plan)) {
      throw new ProjectHarnessServiceError(
        "invalid_plan",
        "Project Harness plan digest is invalid",
      );
    }
    if (plan.operation !== expectedOperation || !targetMatches(plan.target, target)) {
      throw new ProjectHarnessServiceError(
        "stale_plan",
        "Project Harness plan is bound to a different operation or registered project/workspace identity",
      );
    }
    const recovery = await recoverProjectHarnessTransactions(target.projectRoot);
    if (recovery.status === "blocked") {
      throw new ProjectHarnessServiceError(
        "transaction_recovery_required",
        recovery.reason,
        recovery.transactionIds,
      );
    }
    const current = await preview(target, expectedOperation);
    if (!current.readyToApply) {
      throw new ProjectHarnessServiceError(
        "not_ready",
        "Project Harness preview contains protected or unresolved files and cannot be applied",
        current.changes
          .filter(
            (change) =>
              change.action === "blocked" || change.action === "manual_reconciliation_required",
          )
          .map((change) => change.path),
      );
    }
    if (current.plan.planDigest !== plan.planDigest) {
      throw new ProjectHarnessServiceError(
        "stale_plan",
        "Project Harness files changed after preview; obtain a fresh preview",
        current.changes
          .filter((change) => change.action !== "preserve")
          .map((change) => change.path),
      );
    }
    const transaction = await applyProjectHarnessFileTransaction({
      rootPath: target.projectRoot,
      guards: plan.guards,
      writes: plan.files,
    });
    if (!transaction.ok) {
      throw new ProjectHarnessServiceError(
        transaction.error.code,
        `Project Harness transaction failed: ${transaction.error.code}`,
        transaction.error.paths ?? [],
      );
    }
    const inspection = await inspect(target);
    return {
      operation: expectedOperation,
      transactionId: transaction.transactionId,
      changedPaths: transaction.changedPaths,
      inspection,
      recovery:
        recovery.status === "recovered" || transaction.recoveredTransactionIds.length > 0
          ? {
              status: "recovered",
              transactionIds: [...recovery.transactionIds, ...transaction.recoveredTransactionIds],
            }
          : { status: "none", transactionIds: [] },
    };
  }

  return {
    inspect,
    preview,
    apply: (target, plan) => mutate(target, plan, "bootstrap"),
    update: (target, plan) => mutate(target, plan, "update"),
  };
}
