import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

export type WorkspaceProtocolCreateAdmissionFailureKind =
  | "unsupported"
  | "inspection_failed"
  | "missing"
  | "invalid"
  | "unreadable";

export function workspaceProtocolAdmissionMessageKey(
  kind: WorkspaceProtocolCreateAdmissionFailureKind,
):
  | "workspaceSetup.errors.workspaceProtocolRequired"
  | "workspaceSetup.errors.workspaceProtocolUnsupported"
  | "workspaceSetup.errors.workspaceProtocolInspectionFailed" {
  if (kind === "unsupported") return "workspaceSetup.errors.workspaceProtocolUnsupported";
  if (kind === "inspection_failed") {
    return "workspaceSetup.errors.workspaceProtocolInspectionFailed";
  }
  return "workspaceSetup.errors.workspaceProtocolRequired";
}

export class WorkspaceProtocolCreateAdmissionError extends Error {
  readonly kind: WorkspaceProtocolCreateAdmissionFailureKind;
  readonly projectSettingsRoute: ReturnType<typeof buildProjectSettingsRoute>;

  constructor(input: {
    kind: WorkspaceProtocolCreateAdmissionFailureKind;
    serverId: string;
    projectId: string;
    repoRoot: string;
  }) {
    super(`workspace_protocol_admission_required: ${input.kind}`);
    this.name = "WorkspaceProtocolCreateAdmissionError";
    this.kind = input.kind;
    this.projectSettingsRoute = buildProjectSettingsRoute(input.serverId, input.projectId, {
      protocolRoot: input.repoRoot,
    });
  }
}

export function requiresMaterialWorkspaceProtocol(
  assignment: Pick<
    AssignmentEnvelope,
    "mutationBoundary" | "externalEffectBoundary" | "notebookGrant"
  >,
): boolean {
  return (
    assignment.mutationBoundary.mode !== "no-write" ||
    assignment.externalEffectBoundary.mode !== "denied" ||
    assignment.notebookGrant !== undefined
  );
}

export async function requireWorkspaceProtocolForRole(input: {
  client: Pick<DaemonClient, "inspectWorkspaceProtocol">;
  serverId: string;
  projectId: string;
  repoRoot: string;
  roleId: PaseoRoleId | null | undefined;
  assignment: Pick<
    AssignmentEnvelope,
    "mutationBoundary" | "externalEffectBoundary" | "notebookGrant"
  >;
  supported: boolean;
}): Promise<void> {
  if (!input.roleId || !requiresMaterialWorkspaceProtocol(input.assignment)) return undefined;

  if (!input.supported) {
    throw new WorkspaceProtocolCreateAdmissionError({
      kind: "unsupported",
      serverId: input.serverId,
      projectId: input.projectId,
      repoRoot: input.repoRoot,
    });
  }

  let result: Awaited<ReturnType<DaemonClient["inspectWorkspaceProtocol"]>>;
  try {
    result = await input.client.inspectWorkspaceProtocol(input.repoRoot);
  } catch {
    throw new WorkspaceProtocolCreateAdmissionError({
      kind: "inspection_failed",
      serverId: input.serverId,
      projectId: input.projectId,
      repoRoot: input.repoRoot,
    });
  }

  if (!result.ok) {
    throw new WorkspaceProtocolCreateAdmissionError({
      kind: "inspection_failed",
      serverId: input.serverId,
      projectId: input.projectId,
      repoRoot: input.repoRoot,
    });
  }
  if (result.snapshot.status === "valid") return;

  throw new WorkspaceProtocolCreateAdmissionError({
    kind: result.snapshot.status,
    serverId: input.serverId,
    projectId: input.projectId,
    repoRoot: input.repoRoot,
  });
}
