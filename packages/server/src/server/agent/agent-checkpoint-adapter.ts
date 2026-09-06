import type {
  AgentCheckpointSources,
  CheckpointBeadsIssueSnapshot,
  CheckpointBeadsSnapshot,
} from "./agent-checkpoint.js";
import type { BeadsProjectContext, BeadsService } from "../beads/beads-service.js";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";

export interface CheckpointBeadsTargetBinding {
  issueId: string;
  targetAgentId: string;
}

/**
 * A dependency count is accepted only when a caller supplies a complete,
 * target-bound dependency read. The count on a normal issue receipt is not
 * enough: it may be omitted, stale, or scoped to a different target.
 */
export interface CheckpointBeadsDependencySnapshot {
  complete: boolean;
  openDependencyCount: number | null;
}

export interface AdaptBeadsCheckpointInput {
  issue: BeadsIssue | null;
  targetAgentId: string;
  binding: CheckpointBeadsTargetBinding | null;
  dependencies?: CheckpointBeadsDependencySnapshot | null;
}

function normalizeAssignee(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Convert a Beads issue into the generic checkpoint shape without treating
 * assignee or an omitted dependency count as authority. A mismatch between
 * the exact issue/target binding and the returned issue is inaccessible to the
 * checkpoint projection, not a disposition.
 */
export function adaptBeadsCheckpoint(input: AdaptBeadsCheckpointInput): CheckpointBeadsSnapshot {
  if (!input.issue) return { accessible: true, issue: null };
  if (
    !input.binding ||
    input.binding.issueId !== input.issue.id ||
    input.binding.targetAgentId !== input.targetAgentId
  ) {
    return {
      accessible: false,
      reason: "exact Beads issue-to-target binding is unavailable",
    };
  }

  const dependencyDataComplete = input.dependencies?.complete === true;
  const openDependencyCount = dependencyDataComplete
    ? (input.dependencies?.openDependencyCount ?? null)
    : null;
  const snapshot: CheckpointBeadsIssueSnapshot = {
    issueId: input.issue.id,
    status: input.issue.status,
    assigneeAgentId: normalizeAssignee(input.issue.assignee),
    openDependencyCount,
    boundTargetAgentId: input.targetAgentId,
    dependencyDataComplete,
  };
  return { accessible: true, issue: snapshot };
}

/** Read one exact issue through the production Beads service boundary. */
export async function readBeadsCheckpoint(input: {
  service: Pick<BeadsService, "get">;
  project: BeadsProjectContext;
  targetAgentId: string;
  binding: CheckpointBeadsTargetBinding | null;
  dependencies?: CheckpointBeadsDependencySnapshot | null;
  signal?: AbortSignal;
}): Promise<CheckpointBeadsSnapshot> {
  if (!input.binding) return { accessible: true, issue: null };
  try {
    const issue = await input.service.get(input.project, input.binding.issueId, input.signal);
    return adaptBeadsCheckpoint({
      issue,
      targetAgentId: input.targetAgentId,
      binding: input.binding,
      dependencies: input.dependencies,
    });
  } catch (error) {
    return {
      accessible: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Keep the adapter's source contract visible to host integrations. */
export type CheckpointSourceAdapter = (
  input: Pick<AgentCheckpointSources, "target">,
) => Promise<CheckpointBeadsSnapshot>;
