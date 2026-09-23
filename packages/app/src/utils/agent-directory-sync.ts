import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { Agent } from "@/stores/session-store";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { resolveProjectPlacement } from "@/utils/project-placement";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type AgentDirectoryFetchEntry = FetchAgentsEntry;
export type AgentDirectoryDelta = Extract<
  SessionOutboundMessage,
  { type: "agent_update" }
>["payload"];

interface PendingPermissionEntry {
  key: string;
  agentId: string;
  request: Agent["pendingPermissions"][number];
}

// Compact payloads can omit immutable Foundation receipts; keep the ones the
// authoritative directory already delivered for the same agent.
export function preserveFoundationReceipts(previous: Agent | undefined, incoming: Agent): Agent {
  return {
    ...incoming,
    ...(incoming.roleBinding || !previous?.roleBinding
      ? {}
      : { roleBinding: previous.roleBinding }),
    ...(incoming.launchContract || !previous?.launchContract
      ? {}
      : { launchContract: previous.launchContract }),
    ...(incoming.launchProfile || !previous?.launchProfile
      ? {}
      : { launchProfile: previous.launchProfile }),
    ...(incoming.coordinationSignals || !previous?.coordinationSignals
      ? {}
      : { coordinationSignals: previous.coordinationSignals }),
  };
}

export function buildAgentDirectoryState(input: {
  serverId: string;
  entries: AgentDirectoryFetchEntry[];
  previous?: ReadonlyMap<string, Agent>;
}): {
  agents: Map<string, Agent>;
  pendingPermissions: Map<string, PendingPermissionEntry>;
} {
  const agents = new Map<string, Agent>();
  const pendingPermissions = new Map<string, PendingPermissionEntry>();

  for (const entry of input.entries) {
    const normalized = normalizeAgentSnapshot(entry.agent, input.serverId);
    const projectPlacement = resolveProjectPlacement({
      projectPlacement: entry.project,
      cwd: normalized.cwd,
    });
    const agent = preserveFoundationReceipts(input.previous?.get(normalized.id), {
      ...normalized,
      projectPlacement,
    });
    agents.set(agent.id, agent);

    for (const request of agent.pendingPermissions) {
      const key = derivePendingPermissionKey(agent.id, request);
      pendingPermissions.set(key, { key, agentId: agent.id, request });
    }
  }

  return { agents, pendingPermissions };
}
