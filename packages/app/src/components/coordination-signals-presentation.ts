import type { CoordinationSignal } from "@getpaseo/protocol/coordination-signal";

export function signalRecencyTimestamp(signal: CoordinationSignal): number {
  const value = signal.resolvedAt ?? signal.lastOccurredAt ?? signal.createdAt;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export interface PartitionedCoordinationSignals {
  pending: CoordinationSignal[];
  history: CoordinationSignal[];
}

// Bounded presentation only: daemon storage is never mutated or capped. Every pending
// signal is always shown; history (already-resolved signals) is collapsed by default
// behind an explicit toggle, but never truncated once expanded.
export function partitionCoordinationSignals(
  signals: readonly CoordinationSignal[],
): PartitionedCoordinationSignals {
  const pending = signals.filter((signal) => signal.status === "pending");
  const history = signals
    .filter((signal) => signal.status !== "pending")
    .slice()
    .sort((a, b) => signalRecencyTimestamp(b) - signalRecencyTimestamp(a));
  return { pending, history };
}

// `continuity_attention` signals are raised for both real questions (an answer is
// expected) and system notices (nothing to answer, just FYI). Labeling every one of
// them "Attention question" misleads readers about whether action is required.
export function resolveKindLabelKey(signal: Pick<CoordinationSignal, "kind" | "question">): string {
  if (signal.kind === "continuity_attention" && !signal.question) {
    return "agentPanel.coordinationSignals.kind.continuity_notice";
  }
  return `agentPanel.coordinationSignals.kind.${signal.kind}`;
}
