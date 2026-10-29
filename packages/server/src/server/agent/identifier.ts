import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

export interface ResolveAgentIdentifierInput {
  identifier: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
}

export type ResolveAgentIdentifierResult =
  | { ok: true; agentId: string }
  | { ok: false; notFound: boolean; error: string };

export async function resolveAgentIdentifier(
  input: ResolveAgentIdentifierInput,
): Promise<ResolveAgentIdentifierResult> {
  const trimmed = input.identifier.trim();
  if (!trimmed) {
    return { ok: false, notFound: false, error: "Agent identifier cannot be empty" };
  }

  // An internal agent, live or recently archived, is addressable by its exact
  // id and nothing else: the caller that created it holds the id, and no
  // listing ever includes it.
  if (input.agentManager.getAgent(trimmed) || input.agentManager.getRetiredInternalAgent(trimmed)) {
    return { ok: true, agentId: trimmed };
  }

  const stored = await input.agentStorage.list();
  const storedRecords = stored.filter((record) => !record.internal);
  const knownIds = new Set(storedRecords.map((record) => record.id));
  for (const agent of input.agentManager.listAgents()) {
    knownIds.add(agent.id);
  }

  if (knownIds.has(trimmed)) {
    return { ok: true, agentId: trimmed };
  }

  const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
  if (prefixMatches.length === 1) {
    return { ok: true, agentId: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      notFound: false,
      error: `Agent identifier "${trimmed}" is ambiguous (${formatAgentIds(prefixMatches)})`,
    };
  }

  const titleMatches = storedRecords.filter((record) => record.title === trimmed);
  if (titleMatches.length === 1) {
    return { ok: true, agentId: titleMatches[0].id };
  }
  if (titleMatches.length > 1) {
    return {
      ok: false,
      notFound: false,
      error: `Agent title "${trimmed}" is ambiguous (${formatAgentIds(
        titleMatches.map((record) => record.id),
      )})`,
    };
  }

  return { ok: false, notFound: true, error: `Agent not found: ${trimmed}` };
}

function formatAgentIds(agentIds: string[]): string {
  const displayedIds = agentIds.slice(0, 5).map((id) => id.slice(0, 8));
  return `${displayedIds.join(", ")}${agentIds.length > 5 ? ", …" : ""}`;
}
