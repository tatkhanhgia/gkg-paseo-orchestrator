/**
 * Pure canonical Council receipt-only projection for finish notifications.
 *
 * A finish notification normally quotes the child's last assistant message.
 * If the child is a Council seat that has not yet cleared the collection
 * barrier, quoting that message can leak a premise or verdict to the Lead
 * before independent-first-view collection finishes (see the G1 "sealed"
 * requirement). The case-level `phase` on a `CouncilCaseRecord` is the max
 * of every seat's phase, so a case can read `review` while THIS seat is
 * still `sealed` — gating on the case-wide phase would leak that seat's
 * content. This module only trusts a caller-supplied projection of the
 * SEAT that actually belongs to the finishing child, never a case-wide
 * value and never an agent-record label.
 */

export type FinishNotificationCouncilPhase = "sealed" | "review" | "audit" | "verdict";
export const SLP_FINISH_NOTIFICATION_POLICY_VERSION = "2";

export interface FinishNotificationCouncilSeatProjection {
  caseId: string;
  seatId: string;
  phase: FinishNotificationCouncilPhase;
  /** True once this seat's own contribution is finalized (has a report receipt). */
  terminal: boolean;
  /** Opaque locator for the seat's report receipt. Never the receipt's content. */
  receiptPointer: string | null;
}

/**
 * Result of the integration owner's canonical lookup for a finishing child.
 * `unknown` covers both a lookup error and an ambiguous match (e.g. more than
 * one case/seat resolves for the same child+parent/workspace) and MUST be
 * treated identically to `sealed` by the caller: fail closed, not open.
 */
export type FinishNotificationCouncilSeatLookup =
  | { status: "not_council" }
  | { status: "unknown" }
  | { status: "found"; seat: FinishNotificationCouncilSeatProjection };

export type FinishNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

export interface FinishNotificationPermissionRequestProjection {
  id: string;
  provider: string;
  kind: string;
  name: string;
  description: string | null;
  input: unknown;
}

export interface ResolveFinishNotificationContentInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: FinishNotificationPermissionRequestProjection;
  councilSeat: FinishNotificationCouncilSeatLookup;
}

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

function isReceiptOnlyBarrier(lookup: FinishNotificationCouncilSeatLookup): boolean {
  if (lookup.status === "not_council") return false;
  if (lookup.status === "unknown") return true;
  return lookup.seat.phase === "sealed" || lookup.seat.terminal !== true;
}

function formatReceiptOnlyBody(seat: FinishNotificationCouncilSeatProjection): string {
  return [
    "<council-seat>",
    `Case: ${seat.caseId}`,
    `Seat: ${seat.seatId}`,
    `Terminal: ${seat.terminal}`,
    `Receipt: ${seat.receiptPointer ?? "pending"}`,
    "This seat is sealed. Its response content is withheld until the collection",
    "barrier opens; only the case/seat/terminal/receipt pointer above is safe to project.",
    "</council-seat>",
  ].join("\n");
}

function formatUnknownCouncilStatusBody(): string {
  return [
    "<council-seat>",
    "Canonical Council seat status could not be resolved for this agent.",
    "Failing closed: response content is withheld until the seat's canonical",
    "phase can be confirmed as not sealed.",
    "</council-seat>",
  ].join("\n");
}

/**
 * Pure — no I/O, no clock reads besides what the caller passes in. Given the
 * same input it always returns the same body.
 */
export function resolveFinishNotificationContent(
  input: ResolveFinishNotificationContentInput,
): string {
  const statusLine = `Agent ${input.childAgentId} (${input.title}) ${input.reason}.`;
  const sections = [statusLine];
  const barrier = isReceiptOnlyBarrier(input.councilSeat);

  if (input.reason === "needs permission" && input.permissionRequest) {
    // Evaluate the barrier BEFORE deciding what to include: a sealed or
    // unknown-status seat must never see the raw name/description/input of
    // a tool call, only a bounded locator it can echo back on
    // `respond_to_permission`. Building the full payload first and
    // discarding it after the barrier check would still leak it into
    // intermediate state; decide the shape up front instead.
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        barrier
          ? {
              agentId: input.childAgentId,
              requestId: input.permissionRequest.id,
            }
          : {
              agentId: input.childAgentId,
              requestId: input.permissionRequest.id,
              request: input.permissionRequest,
            },
        null,
        2,
      )}\n</permission-request>`,
    );
  }

  if (barrier) {
    sections.push(
      input.councilSeat.status === "found"
        ? formatReceiptOnlyBody(input.councilSeat.seat)
        : formatUnknownCouncilStatusBody(),
    );
    return sections.join("\n\n");
  }

  let lastAssistantMessage = input.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}
