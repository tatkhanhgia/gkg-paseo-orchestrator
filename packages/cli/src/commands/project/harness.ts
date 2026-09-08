import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  ProjectHarnessPlanSchema,
  type ProjectHarnessApplyPayload,
  type ProjectHarnessChange,
  ProjectHarnessFileRevisionSchema,
  type ProjectHarnessInspectPayload,
  type ProjectHarnessInspection,
  type ProjectHarnessMutationResult,
  type ProjectHarnessNotebookReleasePayload,
  type ProjectHarnessOperation,
  type ProjectHarnessPlan,
  type ProjectHarnessPreviewPayload,
  type ProjectHarnessRpcError,
  type ProjectHarnessUpdatePayload,
} from "@getpaseo/protocol/messages";
import type {
  AnyCommandResult,
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

interface ProjectHarnessTargetOptions extends CommandOptions {
  workspace?: string;
  cwd?: string;
}

interface ProjectHarnessPlanOptions extends ProjectHarnessTargetOptions {
  planFile?: string;
}

interface ProjectHarnessReleaseOptions extends ProjectHarnessTargetOptions {
  notebookId?: string;
  location?: string;
  designatedWriterId?: string;
  expectedRevisionFile?: string;
}

interface ProjectHarnessReleaseOutput {
  release: ProjectHarnessNotebookReleaseSuccess;
  freshInspection: ProjectHarnessInspectSuccess | null;
}

type ProjectHarnessInspectSuccess = Extract<ProjectHarnessInspectPayload, { ok: true }>;
type ProjectHarnessPreviewSuccess = Extract<ProjectHarnessPreviewPayload, { ok: true }>;
type ProjectHarnessApplySuccess = Extract<ProjectHarnessApplyPayload, { ok: true }>;
type ProjectHarnessUpdateSuccess = Extract<ProjectHarnessUpdatePayload, { ok: true }>;
type ProjectHarnessNotebookReleaseSuccess = Extract<
  ProjectHarnessNotebookReleasePayload,
  { ok: true }
>;

type ProjectHarnessMutationReceipt =
  | ProjectHarnessMutationResult
  | Extract<ProjectHarnessNotebookReleasePayload, { ok: true }>["result"];

type ProjectHarnessReadbackFailure =
  | { kind: "rpc"; error: ProjectHarnessRpcError }
  | { kind: "transport"; error: unknown };

type ProjectHarnessReadback =
  | { ok: true; requestId: string; inspection: ProjectHarnessInspection }
  | { ok: false; failure: ProjectHarnessReadbackFailure };

const inspectSchema: OutputSchema<ProjectHarnessInspectSuccess> = {
  idField: () => "project-harness",
  columns: [{ header: "STATUS", field: () => "ok" }],
  renderHuman: (result) => renderProjectHarnessResult(result, renderInspectPayload),
};

const previewSchema: OutputSchema<ProjectHarnessPreviewSuccess> = {
  idField: () => "project-harness",
  columns: [{ header: "STATUS", field: () => "ok" }],
  renderHuman: (result) => renderProjectHarnessResult(result, renderPreviewPayload),
};

const applySchema: OutputSchema<ProjectHarnessApplySuccess> = {
  idField: () => "project-harness",
  columns: [{ header: "STATUS", field: () => "ok" }],
  renderHuman: (result) => renderProjectHarnessResult(result, renderMutationPayload),
};

const updateSchema: OutputSchema<ProjectHarnessUpdateSuccess> = {
  idField: () => "project-harness",
  columns: [{ header: "STATUS", field: () => "ok" }],
  renderHuman: (result) => renderProjectHarnessResult(result, renderMutationPayload),
};

const releaseSchema: OutputSchema<ProjectHarnessReleaseOutput> = {
  idField: () => "project-harness",
  columns: [{ header: "STATUS", field: () => "ok" }],
  renderHuman: (result) => renderProjectHarnessResult(result, renderReleaseOutput),
};

export function addProjectHarnessTargetOptions<T extends Command>(command: T): T {
  return command
    .requiredOption("--workspace <workspace-id>", "Registered workspace id")
    .option("--cwd <path>", "Optional cwd inside the registered workspace");
}

export function addProjectHarnessPlanOption<T extends Command>(command: T): T {
  return command.requiredOption("--plan-file <path>", "JSON plan returned by preview");
}

export function addProjectHarnessReleaseOptions<T extends Command>(command: T): T {
  return command
    .requiredOption("--notebook-id <notebook-id>", "Current supervisor notebook id")
    .requiredOption("--location <path>", "Current supervisor notebook location")
    .requiredOption("--designated-writer-id <agent-id>", "Current designated writer id")
    .requiredOption(
      "--expected-revision-file <path>",
      "JSON file containing the current metadata revision or inspect response",
    );
}

export async function runProjectHarnessInspectCommand(
  projectId: string,
  options: ProjectHarnessTargetOptions,
  _command: Command,
): Promise<SingleResult<ProjectHarnessInspectSuccess>> {
  const target = resolveTarget(projectId, options);
  const client = await connectHarnessClient(options);
  try {
    const payload = await client.inspectProjectHarness(target);
    if (!payload.ok) throw projectHarnessRpcCommandError("inspect", payload.error);
    return { type: "single", data: payload, schema: inspectSchema };
  } catch (error) {
    throw projectHarnessCommandError("inspect", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runProjectHarnessPreviewCommand(
  projectId: string,
  operation: string,
  options: ProjectHarnessTargetOptions,
  _command: Command,
): Promise<SingleResult<ProjectHarnessPreviewSuccess>> {
  const target = resolveTarget(projectId, options);
  const resolvedOperation = resolveOperation(operation);
  const client = await connectHarnessClient(options);
  try {
    const payload = await client.previewProjectHarness({ ...target, operation: resolvedOperation });
    if (!payload.ok) throw projectHarnessRpcCommandError("preview", payload.error);
    return { type: "single", data: payload, schema: previewSchema };
  } catch (error) {
    throw projectHarnessCommandError("preview", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runProjectHarnessApplyCommand(
  projectId: string,
  options: ProjectHarnessPlanOptions,
  _command: Command,
): Promise<SingleResult<ProjectHarnessApplySuccess>> {
  const target = resolveTarget(projectId, options);
  const plan = readProjectHarnessPlan(options.planFile);
  const client = await connectHarnessClient(options);
  try {
    const payload = await client.applyProjectHarness({ ...target, plan });
    if (!payload.ok) throw projectHarnessRpcCommandError("apply", payload.error);
    const readback = await readProjectHarnessReadback(client, target);
    if (!readback.ok) {
      throw projectHarnessReadbackCommandError("apply", payload.result, readback.failure);
    }
    return {
      type: "single",
      data: { ...payload, result: { ...payload.result, inspection: readback.inspection } },
      schema: applySchema,
    };
  } catch (error) {
    throw projectHarnessCommandError("apply", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runProjectHarnessUpdateCommand(
  projectId: string,
  options: ProjectHarnessPlanOptions,
  _command: Command,
): Promise<SingleResult<ProjectHarnessUpdateSuccess>> {
  const target = resolveTarget(projectId, options);
  const plan = readProjectHarnessPlan(options.planFile);
  const client = await connectHarnessClient(options);
  try {
    const payload = await client.updateProjectHarness({ ...target, plan });
    if (!payload.ok) throw projectHarnessRpcCommandError("update", payload.error);
    const readback = await readProjectHarnessReadback(client, target);
    if (!readback.ok) {
      throw projectHarnessReadbackCommandError("update", payload.result, readback.failure);
    }
    return {
      type: "single",
      data: { ...payload, result: { ...payload.result, inspection: readback.inspection } },
      schema: updateSchema,
    };
  } catch (error) {
    throw projectHarnessCommandError("update", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runProjectHarnessReleaseCommand(
  projectId: string,
  options: ProjectHarnessReleaseOptions,
  _command: Command,
): Promise<SingleResult<ProjectHarnessReleaseOutput>> {
  const target = resolveTarget(projectId, options);
  const selectors = resolveReleaseSelectors(options);
  const expectedRevision = readProjectHarnessRevision(options.expectedRevisionFile);
  const client = await connectHarnessClient(options);
  try {
    const release = await client.releaseProjectHarnessNotebook({
      ...target,
      ...selectors,
      expectedRevision,
    });
    if (!release.ok) throw projectHarnessRpcCommandError("release", release.error);
    const readback = await readProjectHarnessReadback(client, target);
    if (!readback.ok) {
      throw projectHarnessReadbackCommandError("release", release.result, readback.failure);
    }
    return {
      type: "single",
      data: {
        release,
        freshInspection: {
          requestId: readback.requestId,
          ok: true,
          inspection: readback.inspection,
        },
      },
      schema: releaseSchema,
    };
  } catch (error) {
    throw projectHarnessCommandError("release", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function resolveOperation(value: string): ProjectHarnessOperation {
  if (value === "bootstrap" || value === "update") return value;
  throw {
    code: "INVALID_OPERATION",
    message: `Unsupported Project Harness operation: ${value}`,
    details: "Use bootstrap or update.",
  } satisfies CommandError;
}

export function readProjectHarnessPlan(planFile: string | undefined): ProjectHarnessPlan {
  const file = planFile?.trim();
  if (!file) {
    throw {
      code: "MISSING_PLAN_FILE",
      message: "A guarded Project Harness plan is required",
      details: "Run preview first, save its JSON output, then pass --plan-file <path>.",
    } satisfies CommandError;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw {
      code: "INVALID_PLAN",
      message: `Could not read Project Harness plan ${file}`,
      details: detail,
    } satisfies CommandError;
  }

  let previewPlan = parsed;
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed && "plan" in parsed) {
    const previewEnvelope = parsed as { ok?: unknown; plan?: unknown };
    if (previewEnvelope.ok === true) previewPlan = previewEnvelope.plan;
  }
  const result = ProjectHarnessPlanSchema.safeParse(previewPlan);
  if (!result.success) {
    throw {
      code: "INVALID_PLAN",
      message: `Project Harness plan ${file} does not match the daemon plan schema`,
      details: result.error.issues.map((issue) => issue.path.join(".") || "plan").join(", "),
    } satisfies CommandError;
  }
  return result.data;
}

export function readProjectHarnessRevision(revisionFile: string | undefined) {
  const file = revisionFile?.trim();
  if (!file) {
    throw {
      code: "MISSING_EXPECTED_REVISION",
      message: "A current Project Harness metadata revision is required",
      details: "Run inspect first, save the revision, then pass --expected-revision-file <path>.",
    } satisfies CommandError;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw {
      code: "INVALID_EXPECTED_REVISION",
      message: `Could not read Project Harness revision ${file}`,
      details: detail,
    } satisfies CommandError;
  }

  let revisionCandidate = parsed;
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed && "inspection" in parsed) {
    const inspectEnvelope = parsed as { ok?: unknown; inspection?: unknown };
    if (inspectEnvelope.ok === true && typeof inspectEnvelope.inspection === "object") {
      const inspection = inspectEnvelope.inspection as {
        metadata?: { revision?: unknown };
      };
      revisionCandidate = inspection.metadata?.revision;
    }
  }
  const result = ProjectHarnessFileRevisionSchema.safeParse(revisionCandidate);
  if (!result.success) {
    throw {
      code: "INVALID_EXPECTED_REVISION",
      message: `Project Harness revision ${file} does not match the daemon revision schema`,
      details: result.error.issues.map((issue) => issue.path.join(".") || "revision").join(", "),
    } satisfies CommandError;
  }
  return result.data;
}

function resolveTarget(
  projectId: string,
  options: ProjectHarnessTargetOptions,
): { projectId: string; workspaceId: string; cwd?: string } {
  const normalizedProjectId = projectId.trim();
  const workspaceId = options.workspace?.trim() ?? "";
  if (!normalizedProjectId || !workspaceId) {
    throw {
      code: "INVALID_TARGET",
      message: "Project id and registered workspace id are required",
      details: "Pass <project-id> and --workspace <workspace-id>.",
    } satisfies CommandError;
  }

  const cwd = options.cwd?.trim();
  return {
    projectId: normalizedProjectId,
    workspaceId,
    ...(cwd ? { cwd } : {}),
  };
}

function resolveReleaseSelectors(options: ProjectHarnessReleaseOptions): {
  notebookId: string;
  location: string;
  designatedWriterId: string;
} {
  const notebookId = options.notebookId?.trim() ?? "";
  const location = options.location?.trim() ?? "";
  const designatedWriterId = options.designatedWriterId?.trim() ?? "";
  if (!notebookId || !location || !designatedWriterId) {
    throw {
      code: "INVALID_RELEASE_SELECTORS",
      message: "Notebook id, location, and designated writer id are required",
      details: "Use the values from a fresh Project Harness inspection.",
    } satisfies CommandError;
  }
  return { notebookId, location, designatedWriterId };
}

async function connectHarnessClient(options: ProjectHarnessTargetOptions) {
  return connectToDaemon({ host: options.host }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ host: options.host, error });
  });
}

async function readProjectHarnessReadback(
  client: Awaited<ReturnType<typeof connectHarnessClient>>,
  target: { projectId: string; workspaceId: string; cwd?: string },
): Promise<ProjectHarnessReadback> {
  try {
    const readback = await client.inspectProjectHarness(target);
    if (!readback.ok) return { ok: false, failure: { kind: "rpc", error: readback.error } };
    return { ok: true, requestId: readback.requestId, inspection: readback.inspection };
  } catch (error) {
    return { ok: false, failure: { kind: "transport", error } };
  }
}

function projectHarnessRpcCommandError(
  operation: string,
  error: ProjectHarnessRpcError,
): CommandError {
  return {
    code: error.code,
    message: error.message ?? `Project Harness ${operation} failed`,
    details: { operation, rpc: error },
  };
}

function projectHarnessCommandError(operation: string, error: unknown): CommandError {
  if (isCommandError(error)) return error;
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : `Project Harness ${operation} request failed`;
  return {
    code: `PROJECT_HARNESS_${operation.toUpperCase()}_FAILED`,
    message,
    details: serializeThrownError(error),
  };
}

function projectHarnessReadbackCommandError(
  operation: string,
  completed: ProjectHarnessMutationReceipt,
  failure: ProjectHarnessReadbackFailure,
): CommandError {
  return {
    code: `PROJECT_HARNESS_${operation.toUpperCase()}_READBACK_FAILED`,
    message: `Project Harness ${operation} completed, but fresh inspection failed. Run project harness inspect or reload before retrying.`,
    details: {
      operation,
      completed,
      readback:
        failure.kind === "rpc"
          ? { kind: failure.kind, rpc: failure.error }
          : { kind: failure.kind, error: serializeThrownError(failure.error) },
      nextStep:
        "Run project harness inspect for the same project/workspace, then reload before retrying.",
    },
  };
}

function serializeThrownError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  );
}

function renderInspectPayload(payload: ProjectHarnessInspectSuccess): string {
  return renderInspection(payload.inspection);
}

function renderPreviewPayload(payload: ProjectHarnessPreviewSuccess): string {
  const lines = [
    renderInspection(payload.inspection),
    `operation: ${payload.plan.operation}`,
    `planDigest: ${payload.plan.planDigest}`,
    `readyToApply: ${String(payload.readyToApply)}`,
    `changes: ${payload.changes.length}`,
  ];
  lines.push(...renderChanges(payload.changes));
  return lines.join("\n");
}

function renderMutationPayload(
  payload: ProjectHarnessApplySuccess | ProjectHarnessUpdateSuccess,
): string {
  return renderMutation(payload.result);
}

function renderProjectHarnessResult<T>(
  result: AnyCommandResult<T>,
  render: (data: T) => string,
): string {
  const data = result.type === "single" ? [result.data] : result.data;
  return data.map(render).join("\n\n");
}

function renderInspection(inspection: ProjectHarnessInspection): string {
  const foreignLocalDeltaCount = inspection.foreignOwnership.entries.filter(
    (entry) => entry.drift === "local_delta",
  ).length;
  const unresolvedForeignCount = inspection.foreignOwnership.entries.filter(
    (entry) => entry.drift === "missing" || entry.drift === "unreadable",
  ).length;
  const unknownCoverageCount = inspection.instructionVisibility.filter(
    (entry) => entry.status === "not_scanned" || entry.ownedBy === "unknown",
  ).length;
  return [
    `target: ${inspection.target.projectId}/${inspection.target.workspaceId}`,
    `cwd: ${inspection.target.cwd}`,
    `relationship: ${inspection.relationship.kind}`,
    `provenance: ${inspection.provenance.package}@${inspection.provenance.generation}`,
    `artifactDigest: ${inspection.provenance.artifactDigest}`,
    `metadata: ${inspection.metadata.status}`,
    `foreignOwnership: ${inspection.foreignOwnership.status}`,
    `foreignLocalDelta: ${foreignLocalDeltaCount}`,
    `foreignUnresolved: ${unresolvedForeignCount}`,
    `instructionCoverage: ${inspection.instructionVisibility.length}`,
    `instructionUnknown: ${unknownCoverageCount}`,
    `recovery: ${inspection.recovery.status}`,
  ].join("\n");
}

function renderChanges(changes: readonly ProjectHarnessChange[]): string[] {
  return changes.flatMap((change) => [
    `- ${change.action}: ${change.path}`,
    ...(change.reason ? [`  reason: ${change.reason}`] : []),
    ...(change.diff ? [`  diff:\n${change.diff}`] : []),
  ]);
}

function renderMutation(result: ProjectHarnessMutationResult): string {
  return [
    `operation: ${result.operation}`,
    `transactionId: ${result.transactionId}`,
    `changedPaths: ${result.changedPaths.length}`,
    ...result.changedPaths.map((path) => `- ${path}`),
    renderInspection(result.inspection),
    `recovery: ${result.recovery.status}`,
    ...(result.recovery.reason ? [`recoveryReason: ${result.recovery.reason}`] : []),
  ].join("\n");
}

function renderReleaseOutput(output: ProjectHarnessReleaseOutput): string {
  const result = output.release.result;
  const lines = [
    `projectId: ${result.projectId}`,
    `workspaceId: ${result.workspaceId}`,
    `notebookId: ${result.notebookId}`,
    `location: ${result.location}`,
    `releasedWriterId: ${result.releasedWriterId}`,
    `metadataRevision: ${JSON.stringify(result.metadataRevision)}`,
    `nextStep: ${result.nextStep}`,
  ];
  if (output.freshInspection?.ok) {
    lines.push("freshReadback:", renderInspection(output.freshInspection.inspection));
  } else {
    lines.push("freshReadback: unavailable");
  }
  return lines.join("\n");
}
