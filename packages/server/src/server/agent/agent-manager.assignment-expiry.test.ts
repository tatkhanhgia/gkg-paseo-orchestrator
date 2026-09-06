import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import type { AssignmentEnvelope } from "@getpaseo/protocol/assignment-contract";
import { buildWorkspaceProtocolTemplate } from "../../utils/workspace-protocol-file.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
  AgentSessionConfig,
  ProviderCatalog,
  ProviderLaunchBinding,
} from "./agent-sdk-types.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsNativePaseoTools: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

class DelayedBoundarySession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  readonly modeEntered = deferred();
  readonly modeReleased = deferred();
  providerStartCount = 0;

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.providerStartCount += 1;
    throw new Error("provider start should not be reached after assignment expiry");
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return "read-only";
  }

  async setMode(_modeId: string): Promise<void> {
    this.modeEntered.resolve();
    await this.modeReleased.promise;
  }

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class DelayedBoundaryClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly resumeEntered = deferred();
  readonly resumeReleased = deferred();
  initialSession: DelayedBoundarySession | null = null;
  resumedSession: DelayedBoundarySession | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    _config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.initialSession = new DelayedBoundarySession();
    return this.initialSession;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new DelayedBoundarySession();
    this.resumedSession = session;
    this.resumeEntered.resolve();
    await this.resumeReleased.promise;
    return session;
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    return { models: [], modes: [] };
  }

  async materializeProviderLaunchBinding(input: {
    config: AgentSessionConfig;
  }): Promise<ProviderLaunchBinding> {
    return {
      providerId: input.config.provider,
      providerFamily: "codex",
      model: input.config.model ?? "gpt-5.4",
      credentialConfigured: true,
      routeKind: "codex-subscription",
      modelProviderId: "openai",
      authMethod: "codex-native",
    };
  }
}

function leadAssignment(expiresAt: string): AssignmentEnvelope {
  return {
    version: 1,
    disposition: "lead-direct",
    objective: "Exercise the shared start boundary.",
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    evidence: "Record the actual provider-start boundary result.",
    handbackAndStop: "Stop after the bounded regression.",
    expiresAt,
  };
}

test("revalidates assignment expiry after resume and mode preparation before provider start", async () => {
  vi.useFakeTimers();
  const originalNow = new Date("2026-09-06T00:00:00.000Z");
  vi.setSystemTime(originalNow);
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-assignment-expiry-"));
  const logger = createTestLogger();
  const client = new DelayedBoundaryClient();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: client },
    providerDefinitions: {
      codex: { enabled: true, supportsExactMcpPreapproval: true },
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000151",
  });
  const expiresAt = new Date(originalNow.getTime() + 1_000).toISOString();

  writeFileSync(
    join(workdir, "WORKSPACE_PROTOCOL.md"),
    buildWorkspaceProtocolTemplate(workdir),
    "utf8",
  );

  try {
    const agent = await manager.createAgent(
      { provider: "codex", model: "gpt-5.4", cwd: workdir },
      undefined,
      {
        workspaceId: "workspace-assignment-expiry",
        roleId: "lead",
        assignment: leadAssignment(expiresAt),
      },
    );
    await manager.closeAgent(agent.id);

    const dispatch = sendPromptToAgent({
      agentManager: manager,
      agentStorage: storage,
      agentId: agent.id,
      prompt: "This must not reach the provider.",
      sessionMode: "read-only",
      replaceRunning: false,
      waitForRunStart: true,
      logger,
    });

    await client.resumeEntered.promise;
    vi.setSystemTime(new Date(originalNow.getTime() + 1_001));
    client.resumeReleased.resolve();

    const resumedSession = client.resumedSession;
    expect(resumedSession).not.toBeNull();
    await resumedSession!.modeEntered.promise;
    resumedSession!.modeReleased.resolve();

    await expect(dispatch).rejects.toThrow(`assignment_contract_expired: expiresAt=${expiresAt}`);
    expect(client.initialSession?.providerStartCount).toBe(0);
    expect(client.resumedSession?.providerStartCount).toBe(0);
  } finally {
    client.resumeReleased.resolve();
    client.resumedSession?.modeReleased.resolve();
    await manager.closeAgent("00000000-0000-4000-8000-000000000151").catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
