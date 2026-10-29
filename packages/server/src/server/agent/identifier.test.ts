import { describe, expect, test } from "vitest";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { resolveAgentIdentifier } from "./identifier.js";

function storedAgent(
  id: string,
  options: { title?: string; internal?: boolean } = {},
): StoredAgentRecord {
  return {
    id,
    title: options.title ?? null,
    internal: options.internal ?? false,
  } as StoredAgentRecord;
}

function liveAgent(id: string, options: { internal?: boolean } = {}): ManagedAgent {
  return { id, internal: options.internal ?? false } as ManagedAgent;
}

async function resolve(input: {
  identifier: string;
  stored?: StoredAgentRecord[];
  live?: ManagedAgent[];
  retiredInternalIds?: string[];
}) {
  const agentStorage = {
    list: async () => input.stored ?? [],
  } as unknown as AgentStorage;
  const live = input.live ?? [];
  const agentManager = {
    // Like AgentManager, listAgents omits internal agents while getAgent finds them.
    listAgents: () => live.filter((agent) => !agent.internal),
    getAgent: (id: string) => live.find((agent) => agent.id === id) ?? null,
    getRetiredInternalAgent: (id: string) =>
      input.retiredInternalIds?.includes(id) ? { agentId: id } : null,
  } as unknown as AgentManager;
  return resolveAgentIdentifier({
    identifier: input.identifier,
    agentManager,
    agentStorage,
  });
}

describe("resolveAgentIdentifier", () => {
  test("resolves exact IDs, unique prefixes, and stored titles", async () => {
    const stored = [storedAgent("agent-alpha-123", { title: "Release lead" })];
    const live = [liveAgent("agent-beta-456")];

    await expect(resolve({ identifier: "agent-beta-456", stored, live })).resolves.toEqual({
      ok: true,
      agentId: "agent-beta-456",
    });
    await expect(resolve({ identifier: "agent-al", stored, live })).resolves.toEqual({
      ok: true,
      agentId: "agent-alpha-123",
    });
    await expect(resolve({ identifier: "Release lead", stored, live })).resolves.toEqual({
      ok: true,
      agentId: "agent-alpha-123",
    });
  });

  test("fails closed on ambiguous prefixes and excludes internal agent titles", async () => {
    const stored = [
      storedAgent("agent-alpha-123"),
      storedAgent("agent-alpha-456"),
      storedAgent("agent-hidden-789", { title: "Hidden", internal: true }),
    ];

    await expect(resolve({ identifier: "agent-alpha", stored })).resolves.toEqual({
      ok: false,
      notFound: false,
      error: expect.stringContaining("ambiguous"),
    });
    await expect(resolve({ identifier: "Hidden", stored })).resolves.toEqual({
      ok: false,
      notFound: true,
      error: "Agent not found: Hidden",
    });
  });

  test("addresses live and retired internal agents only by exact ID", async () => {
    const live = [liveAgent("internal-live-123", { internal: true })];
    const retiredInternalIds = ["internal-retired-456"];

    await expect(
      resolve({ identifier: "internal-live-123", live, retiredInternalIds }),
    ).resolves.toEqual({ ok: true, agentId: "internal-live-123" });
    await expect(
      resolve({ identifier: "internal-retired-456", live, retiredInternalIds }),
    ).resolves.toEqual({ ok: true, agentId: "internal-retired-456" });
    await expect(resolve({ identifier: "internal-", live, retiredInternalIds })).resolves.toEqual({
      ok: false,
      notFound: true,
      error: "Agent not found: internal-",
    });
  });
});
