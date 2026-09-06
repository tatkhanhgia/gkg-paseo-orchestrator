import type { CouncilCaseStore } from "../council/council-case-store.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type {
  FinishNotificationCouncilSeatLookup,
  FinishNotificationCouncilSeatProjection,
} from "./bundled/slp/finish-notification-policy.js";

/**
 * Resolve finish-notification Council status from the canonical case store.
 * Agent labels are only a consistency check; they never establish Council
 * membership. A missing record, failed store read, ambiguous seat assignment,
 * or compromised/incomplete receipt is unknown and therefore content-redacted
 * by the bundled policy.
 */
export function createCanonicalCouncilSeatProjectionResolver(input: {
  councilCaseStore: Pick<CouncilCaseStore, "list">;
  agentStorage: Pick<AgentStorage, "get">;
}): (childAgentId: string) => Promise<FinishNotificationCouncilSeatLookup> {
  return async (childAgentId) => {
    let childRecord: StoredAgentRecord | null;
    try {
      childRecord = await input.agentStorage.get(childAgentId);
    } catch {
      return { status: "unknown" };
    }
    if (!childRecord || childRecord.internal || childRecord.archivedAt) {
      return { status: "unknown" };
    }

    let councils;
    try {
      councils = await input.councilCaseStore.list();
    } catch {
      return { status: "unknown" };
    }

    const matches = councils.flatMap((council) =>
      council.seats
        .filter((seat) => seat.agentId === childAgentId)
        .map((seat) => ({ council, seat })),
    );
    if (matches.length === 0) return { status: "not_council" };
    if (matches.length !== 1) return { status: "unknown" };

    const [{ council, seat }] = matches;
    if (childRecord.workspaceId !== undefined && childRecord.workspaceId !== council.workspaceId) {
      return { status: "unknown" };
    }
    if (
      seat.integrity !== "valid" ||
      !seat.reportReceipt ||
      seat.reportReceipt.authorAgentId !== childAgentId ||
      seat.reportReceipt.roomId !== council.roomId ||
      seat.reportReceipt.kickoffMessageId !== council.kickoffMessageId
    ) {
      return { status: "unknown" };
    }

    const projection: FinishNotificationCouncilSeatProjection = {
      caseId: council.id,
      seatId: childAgentId,
      phase: seat.phase,
      terminal: true,
      receiptPointer: `${seat.reportReceipt.roomId}:${seat.reportReceipt.reportMessageId}`,
    };
    return { status: "found", seat: projection };
  };
}
