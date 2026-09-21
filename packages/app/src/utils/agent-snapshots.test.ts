import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "./agent-snapshots";

function createSnapshot(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    labels?: Record<string, unknown>;
  } = {},
): AgentSnapshotPayload {
  return {
    id: input.id ?? "agent-1",
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
    activeTurn: input.activeTurn,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    title: input.title ?? null,
    labels: (input.labels ?? {}) as AgentSnapshotPayload["labels"],
    roleBinding: input.roleBinding,
    launchContract: input.launchContract,
    coordinationSignals: input.coordinationSignals,
  };
}

describe("normalizeAgentSnapshot", () => {
  it("round-trips identified active turns through the canonical snapshot boundary", () => {
    const snapshot = createSnapshot({
      status: "running",
      activeTurn: { turnId: "turn-1", startedAt: "2026-07-31T12:00:00.000Z" },
    });

    expect(projectAgentSnapshot(normalizeAgentSnapshot(snapshot, "server-1"))).toMatchObject({
      status: "running",
      activeTurn: snapshot.activeTurn,
    });
  });

  it("normalizes identified and legacy active turns at the snapshot boundary", () => {
    const startedAt = "2026-07-31T12:00:00.000Z";
    expect(
      normalizeAgentSnapshot(
        createSnapshot({
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt },
        }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });

    expect(
      normalizeAgentSnapshot(
        createSnapshot({ status: "running", lastUserMessageAt: startedAt }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: null,
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });
  });

  it("derives parentAgentId from the parent label while preserving labels", () => {
    const labels = {
      [PARENT_AGENT_ID_LABEL]: "parent-1",
      "custom.label": "still-here",
    };

    const agent = normalizeAgentSnapshot(createSnapshot({ labels }), "server-1");

    expect(agent.parentAgentId).toBe("parent-1");
    expect(agent.labels).toEqual(labels);
  });

  it("retains the secret-safe immutable launch readback", () => {
    const launchContract: NonNullable<AgentSnapshotPayload["launchContract"]> = {
      version: 1,
      contractDigest: "a".repeat(64),
      roleId: "lead",
      providerId: "codex-proxy",
      providerFamily: "codex",
      model: "custom-model",
      routeKind: "openai-compatible",
      modelProviderId: "codex-proxy",
      authMethod: "credential-command",
      credentialConfigured: true,
      createdAt: "2026-08-06T00:00:00.000Z",
    };

    expect(
      normalizeAgentSnapshot(createSnapshot({ launchContract }), "server-1").launchContract,
    ).toEqual(launchContract);
  });

  it("round-trips role receipts through incremental directory reconciliation", () => {
    const roleBinding: NonNullable<AgentSnapshotPayload["roleBinding"]> = {
      roleId: "supervisor",
      definitionVersion: "1",
      definitionDigest: "b".repeat(64),
      bindingDigest: "c".repeat(64),
      provider: "claude",
      injectionMethod: "claude-system-prompt",
      qualification: "implementation-supported",
      workspaceProtocol: {
        status: "bound",
        readership: "governance-only",
        path: "/repo/WORKSPACE_PROTOCOL.md",
        digest: "d".repeat(64),
      },
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    const launchContract: NonNullable<AgentSnapshotPayload["launchContract"]> = {
      version: 1,
      contractDigest: "e".repeat(64),
      roleId: "supervisor",
      providerId: "claude",
      providerFamily: "claude",
      model: "claude-haiku-4-5",
      routeKind: "provider-native",
      modelProviderId: null,
      authMethod: "provider-native",
      credentialConfigured: true,
      createdAt: "2026-08-17T00:00:00.000Z",
    };

    const projected = projectAgentSnapshot(
      normalizeAgentSnapshot(createSnapshot({ roleBinding, launchContract }), "server-1"),
    );

    expect(projected.roleBinding).toEqual(roleBinding);
    expect(projected.launchContract).toEqual(launchContract);
  });

  it("round-trips current coordination signals through the canonical snapshot boundary", () => {
    const coordinationSignals: NonNullable<AgentSnapshotPayload["coordinationSignals"]> = [
      {
        id: "signal-1",
        targetAgentId: "agent-1",
        requestedByAgentId: null,
        kind: "continuity_attention",
        reason: "Bounded attention question",
        evidenceRefs: ["timeline:turn-7"],
        occurrenceCount: 2,
        status: "pending",
        createdAt: "2026-09-01T00:00:00.000Z",
        deliveredAt: null,
        resolvedAt: null,
      },
    ];

    const projected = projectAgentSnapshot(
      normalizeAgentSnapshot(createSnapshot({ coordinationSignals }), "server-1"),
    );

    expect(projected.coordinationSignals).toEqual(coordinationSignals);
  });

  it("trims whitespace around the parent label", () => {
    const agent = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "  parent-1 \n" } }),
      "server-1",
    );

    expect(agent.parentAgentId).toBe("parent-1");
  });

  it("maps missing, empty, and non-string parent labels to null", () => {
    const missing = normalizeAgentSnapshot(createSnapshot(), "server-1");
    const empty = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } }),
      "server-1",
    );
    const nonString = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } }),
      "server-1",
    );

    expect(missing.parentAgentId).toBeNull();
    expect(empty.parentAgentId).toBeNull();
    expect(nonString.parentAgentId).toBeNull();
  });
});
