import { describe, expect, it, vi } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import type { AssignmentContractReceipt } from "@getpaseo/protocol/assignment-contract";
import type {
  ProviderRoleBindingSupport,
  RoleBindingReceipt,
} from "@getpaseo/protocol/role-binding";
import {
  buildLockedNoWriteModeOption,
  canAttemptModeSelection,
  computeRequiredNoWriteModeId,
  isNoWriteAssignmentEffect,
  persistConfirmedAgentMode,
  requiredNoWriteModeId,
  resolveConfirmedModeId,
  resolveLockedModeOptions,
} from "./effective-agent-modes";

describe("requiredNoWriteModeId", () => {
  it("returns null when the role binding is absent", () => {
    expect(requiredNoWriteModeId(undefined)).toBeNull();
  });

  it("returns null when the role binding is unsupported", () => {
    const roleBinding: ProviderRoleBindingSupport = {
      status: "unsupported",
      reason: "no provider adapter",
    };
    expect(requiredNoWriteModeId(roleBinding)).toBeNull();
  });

  it("mirrors the daemon's authoritative pin for a supported claude binding", () => {
    const roleBinding: ProviderRoleBindingSupport = {
      status: "supported",
      injectionMethod: "claude-system-prompt",
    };
    expect(requiredNoWriteModeId(roleBinding)).toBe("default");
  });

  it("mirrors the daemon's authoritative pin for a supported cursor binding", () => {
    const roleBinding: ProviderRoleBindingSupport = {
      status: "supported",
      injectionMethod: "cursor-project-rule-capsule",
    };
    expect(requiredNoWriteModeId(roleBinding)).toBe("plan");
  });
});

describe("isNoWriteAssignmentEffect", () => {
  it("classifies 'mutating' as not no-write", () => {
    expect(isNoWriteAssignmentEffect("mutating")).toBe(false);
  });

  it("classifies 'delegation' as no-write, matching the server's mutationBoundaryForEffect", () => {
    expect(isNoWriteAssignmentEffect("delegation")).toBe(true);
  });

  it("classifies 'read-only' as no-write", () => {
    expect(isNoWriteAssignmentEffect("read-only")).toBe(true);
  });
});

describe("buildLockedNoWriteModeOption", () => {
  it("builds a single explicit locked entry carrying the pinned mode id", () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      `${key}:${JSON.stringify(options ?? {})}`;
    const option = buildLockedNoWriteModeOption("default", t);
    expect(option.id).toBe("default");
    expect(option.label).toBe('agentControls.mode.lockedOption:{"mode":"default"}');
    expect(option.description).toBe("agentControls.mode.lockedHint:{}");
  });
});

function buildAssignment(
  overrides: Partial<AssignmentContractReceipt> = {},
): AssignmentContractReceipt {
  return {
    version: 1,
    assignmentDigest: "d".repeat(64),
    roleId: "peer",
    disposition: "peer-execution",
    assigner: { kind: "human-session" },
    workspaceId: "workspace",
    cwd: "/repo",
    effectClass: "read-only",
    mutationBoundary: { mode: "no-write" },
    externalEffectBoundary: { mode: "denied" },
    createdAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function buildLiveRoleBindingReceipt(
  overrides: Partial<RoleBindingReceipt> = {},
): RoleBindingReceipt {
  return {
    roleId: "peer",
    definitionVersion: "3.2.0-topology-recovery",
    definitionDigest: "a".repeat(64),
    bindingDigest: "b".repeat(64),
    provider: "claude",
    injectionMethod: "claude-system-prompt",
    qualification: "implementation-supported",
    workspaceProtocol: { status: "missing", readership: "assignment-only", path: "" },
    createdAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeRequiredNoWriteModeId (live agent)", () => {
  it("returns null when the agent has no role binding", () => {
    expect(computeRequiredNoWriteModeId(undefined)).toBeNull();
  });

  it("returns null when the role binding has no assignment envelope", () => {
    expect(
      computeRequiredNoWriteModeId(buildLiveRoleBindingReceipt({ assignment: undefined })),
    ).toBeNull();
  });

  it("returns null when the assignment's mutation boundary is not no-write", () => {
    const receipt = buildLiveRoleBindingReceipt({
      assignment: buildAssignment({ mutationBoundary: { mode: "bounded-write", scope: "src/" } }),
    });
    expect(computeRequiredNoWriteModeId(receipt)).toBeNull();
  });

  it("resolves the daemon's authoritative pin for a no-write assignment (UX-03)", () => {
    const receipt = buildLiveRoleBindingReceipt({
      injectionMethod: "claude-system-prompt",
      assignment: buildAssignment({ mutationBoundary: { mode: "no-write" } }),
    });
    expect(computeRequiredNoWriteModeId(receipt)).toBe("default");
  });
});

describe("resolveLockedModeOptions", () => {
  const modes: AgentMode[] = [
    { id: "default", label: "Default", description: "" },
    { id: "yolo", label: "Yolo", description: "" },
  ];
  const buildLocked = (modeId: string): AgentMode => ({
    id: modeId,
    label: `Locked (${modeId})`,
    description: "locked",
  });

  it("returns null when no mode is pinned", () => {
    expect(resolveLockedModeOptions(modes, null, buildLocked)).toBeNull();
  });

  it("filters to the single pinned mode when it exists in the catalog", () => {
    expect(resolveLockedModeOptions(modes, "default", buildLocked)).toEqual([modes[0]]);
  });

  it("synthesizes a locked entry when the pinned mode is absent from the catalog", () => {
    expect(resolveLockedModeOptions(modes, "plan", buildLocked)).toEqual([buildLocked("plan")]);
  });
});

describe("canAttemptModeSelection", () => {
  it("allows any mode when nothing is pinned", () => {
    expect(canAttemptModeSelection("yolo", null)).toBe(true);
  });

  it("allows selecting the pinned mode itself", () => {
    expect(canAttemptModeSelection("default", "default")).toBe(true);
  });

  it("blocks a client-side attempt to select a mode that contradicts the pin (UX-03)", () => {
    expect(canAttemptModeSelection("yolo", "default")).toBe(false);
  });
});

describe("resolveConfirmedModeId", () => {
  it("confirms persistence only when the readback reports a defined effective mode", () => {
    expect(resolveConfirmedModeId("default")).toBe("default");
  });

  it("refuses to confirm a rejected or still-pending mode change (UX-04)", () => {
    expect(resolveConfirmedModeId(undefined)).toBeNull();
    expect(resolveConfirmedModeId(null)).toBeNull();
  });
});

describe("persistConfirmedAgentMode (UX-04)", () => {
  it("never persists when setAgentMode itself rejects", async () => {
    const persist = vi.fn();
    const fetchAgent = vi.fn();
    await expect(
      persistConfirmedAgentMode({
        agentId: "agent-1",
        modeId: "yolo",
        setAgentMode: () => Promise.reject(new Error("daemon rejected mode")),
        onNotice: vi.fn(),
        fetchAgent,
        persist,
      }),
    ).rejects.toThrow("daemon rejected mode");
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("never persists when the post-write readback itself rejects", async () => {
    const persist = vi.fn();
    await expect(
      persistConfirmedAgentMode({
        agentId: "agent-1",
        modeId: "default",
        setAgentMode: () => Promise.resolve("notice"),
        onNotice: vi.fn(),
        fetchAgent: () => Promise.reject(new Error("network error")),
        persist,
      }),
    ).rejects.toThrow("network error");
    expect(persist).not.toHaveBeenCalled();
  });

  it("never persists when the readback reports no effective mode", async () => {
    const persist = vi.fn();
    await persistConfirmedAgentMode({
      agentId: "agent-1",
      modeId: "default",
      setAgentMode: () => Promise.resolve("notice"),
      onNotice: vi.fn(),
      fetchAgent: () => Promise.resolve({ agent: { currentModeId: null } }),
      persist,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("persists only the readback-confirmed effective mode, not the optimistically requested one", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const onNotice = vi.fn();
    await persistConfirmedAgentMode({
      agentId: "agent-1",
      modeId: "requested-mode",
      setAgentMode: () => Promise.resolve("notice"),
      onNotice,
      fetchAgent: () => Promise.resolve({ agent: { currentModeId: "confirmed-mode" } }),
      persist,
    });
    expect(onNotice).toHaveBeenCalledWith("notice");
    expect(persist).toHaveBeenCalledWith("confirmed-mode");
  });
});
