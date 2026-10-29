import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { withAgentAuthorityLock } from "./agent-authority-lock.js";
import { hasReleasedAgentWriteLease } from "./lead-handoffs.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractAttention,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: { broadcastTimeline: boolean };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "isAgentCloseInFlight" | "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  // An archive queued behind the shared resume runs in the same lifecycle lane; let it
  // land before deciding, so a joined load cannot return a runtime archived meanwhile.
  await deps.agentManager.waitForAgentClose?.(agentId);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  for (;;) {
    const inflight = pendingAgentInitializations.get(agentId);
    if (inflight) {
      inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
      return inflight.promise;
    }

    await deps.agentManager.waitForAgentClose?.(agentId);
    const reservation = await withAgentAuthorityLock(agentId, async () =>
      reserveAgentInitialization(agentId, deps),
    );
    if (reservation.kind === "retry") continue;
    return reservation.promise;
  }
}

async function reserveAgentInitialization(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<{ kind: "load"; promise: Promise<ManagedAgent> } | { kind: "retry" }> {
  if (deps.agentManager.isAgentCloseInFlight?.(agentId)) {
    return { kind: "retry" };
  }

  const authoritativeRecord = await deps.agentStorage.get(agentId);
  if (deps.agentManager.isAgentCloseInFlight?.(agentId)) {
    return { kind: "retry" };
  }
  if (hasReleasedAgentWriteLease(authoritativeRecord)) {
    throw new Error(`agent_write_lease_released_runtime_closed: ${agentId}`);
  }
  const existing = deps.agentManager.getAgent(agentId);
  if (!authoritativeRecord) {
    if (existing) {
      return { kind: "load", promise: Promise.resolve(existing) };
    }
    throw new AgentNotFoundError(agentId);
  }

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return { kind: "load", promise: inflight.promise };
  }

  if (existing) {
    return { kind: "load", promise: Promise.resolve(existing) };
  }

  const pendingOptions = {
    broadcastTimeline: deps.broadcastTimeline === true,
  };
  const initPromise = (async () => {
    const record = authoritativeRecord;

    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    if (!isStoredAgentProviderAvailable(record, validProviders)) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }

    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        {
          ...extractTimestamps(record),
          attention: extractAttention(record),
          roleBinding: record.launchContract ? undefined : record.roleBinding,
          launchContract: record.launchContract,
          launchProfile: record.launchProfile,
        },
        record.archivedAt ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      // No provider handle to resume: this starts the agent's first session rather than
      // bringing one back, so it stamps activity and carries no stored attention. Records
      // without a handle never got far enough to accumulate either.
      const config = buildSessionConfig(record, {
        validProviders,
      });
      if (!config) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }
      snapshot = await deps.agentManager.createAgent(config, agentId, {
        labels: record.labels,
        workspaceId: record.workspaceId,
        owner: record.owner,
        roleBinding: record.launchContract ? undefined : record.roleBinding,
        launchContract: record.launchContract,
        launchProfile: record.launchProfile,
      });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = { promise: initPromise, options: pendingOptions };
  pendingAgentInitializations.set(agentId, pending);
  void initPromise
    .finally(() => {
      const current = pendingAgentInitializations.get(agentId);
      if (current === pending) {
        pendingAgentInitializations.delete(agentId);
      }
    })
    .catch(() => undefined);
  return { kind: "load", promise: initPromise };
}

export function hasPendingAgentInitialization(agentId: string): boolean {
  return pendingAgentInitializations.has(agentId);
}
