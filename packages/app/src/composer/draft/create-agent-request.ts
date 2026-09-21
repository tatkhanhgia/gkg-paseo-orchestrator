import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { AssignmentEffectClass } from "@getpaseo/protocol/assignment-contract";
import type { AgentSnapshotPayload, CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import type { PaseoRoleId } from "@getpaseo/protocol/role-binding";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { encodeImages } from "@/utils/encode-images";
import type { UserMessageImageAttachment } from "@/types/stream";
import { buildAssignmentEnvelope } from "@/workspace-protocol/assignment-envelope";

export interface WorkspaceDraftRoleIntent {
  roleId: PaseoRoleId | null | undefined;
  assignmentEffect: AssignmentEffectClass;
  beadsIssueIds: readonly string[];
  externalEffects: readonly string[];
}

export interface WorkspaceDraftAgentRequest {
  workspaceId: string;
  config: AgentSessionConfig;
  text: string;
  clientMessageId: string;
  images?: UserMessageImageAttachment[];
  attachments?: CreateAgentRequestMessage["attachments"];
  /** Role launch intent; the assignment is scoped to `roleCwd`. */
  role?: WorkspaceDraftRoleIntent;
  roleCwd?: string;
}

/**
 * Shared by the workspace draft tab and by the new-workspace screen when it finishes creation
 * after the user has already navigated away and no draft tab will ever mount. Both paths must
 * carry the selected role so a background create cannot launch an unbound agent.
 */
export async function requestWorkspaceDraftAgent(
  client: DaemonClient,
  request: WorkspaceDraftAgentRequest,
): Promise<AgentSnapshotPayload> {
  const images = await encodeImages(request.images);
  const roleId = request.role?.roleId;
  const result = await client.createAgent({
    config: request.config,
    workspaceId: request.workspaceId,
    ...(roleId && request.role
      ? {
          roleId,
          assignment: buildAssignmentEnvelope({
            roleId,
            effectClass: request.role.assignmentEffect,
            objective: request.text,
            cwd: request.roleCwd ?? request.config.cwd,
            beadsIssueIds: request.role.beadsIssueIds,
            externalEffects: request.role.externalEffects,
          }),
        }
      : {}),
    clientMessageId: request.clientMessageId,
    ...(request.text ? { initialPrompt: request.text } : {}),
    ...(images && images.length > 0 ? { images } : {}),
    ...(request.attachments && request.attachments.length > 0
      ? { attachments: request.attachments }
      : {}),
  });
  assertRoleLaunchReceipt(result, roleId);
  return result;
}

function assertRoleLaunchReceipt(
  result: AgentSnapshotPayload,
  roleId: PaseoRoleId | null | undefined,
): void {
  if (!roleId) return;
  if (result.roleBinding?.roleId === roleId && result.launchContract) return;
  throw new Error(
    `Role launch receipt mismatch: requested ${roleId}, received ${result.roleBinding?.roleId ?? "unbound"}`,
  );
}
