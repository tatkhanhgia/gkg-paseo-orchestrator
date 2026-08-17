import { expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import {
  assertRoleAssignmentModeAllowed,
  assertRoleAssignmentPermissionResponseAllowed,
  enforceRoleAssignmentCapability,
  requiredNoWriteMode,
} from "./assignment-capability-boundary.js";
import type { PersistedRoleBinding } from "./role-binding.js";

function roleBinding(input: {
  injectionMethod: PersistedRoleBinding["injectionMethod"];
  mutationMode?: "no-write" | "bounded-write";
}): PersistedRoleBinding {
  const mutationMode = input.mutationMode ?? "no-write";
  return {
    roleId: "lead",
    injectionMethod: input.injectionMethod,
    assignment: {
      mutationBoundary:
        mutationMode === "no-write"
          ? { mode: "no-write" }
          : { mode: "bounded-write", scope: "src/**" },
    },
  } as PersistedRoleBinding;
}

test("no-write Codex assignment overrides an unattended full-access request", () => {
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd: "/workspace/repo",
    modeId: "full-access",
  };

  expect(
    enforceRoleAssignmentCapability(
      config,
      roleBinding({ injectionMethod: "codex-developer-instructions" }),
    ),
  ).toMatchObject({ modeId: "read-only" });
});

test("no-write Cursor assignment disables ACP auto-accept and pins plan mode", () => {
  const config: AgentSessionConfig = {
    provider: "cursor",
    cwd: "/workspace/repo",
    modeId: "agent",
    featureValues: { auto_accept: true, fast: true },
  };

  expect(
    enforceRoleAssignmentCapability(
      config,
      roleBinding({ injectionMethod: "cursor-project-rule-capsule" }),
    ),
  ).toMatchObject({ modeId: "plan", featureValues: { auto_accept: false, fast: true } });
});

test("no-write Claude assignment pins guarded default mode for the strict tool boundary", () => {
  const config: AgentSessionConfig = {
    provider: "claude",
    cwd: "/workspace/repo",
    modeId: "bypassPermissions",
  };

  expect(
    enforceRoleAssignmentCapability(
      config,
      roleBinding({ injectionMethod: "claude-system-prompt" }),
    ),
  ).toMatchObject({ modeId: "default" });
});

test("bounded-write assignment preserves the requested provider capability", () => {
  const config: AgentSessionConfig = {
    provider: "claude",
    cwd: "/workspace/repo",
    modeId: "bypassPermissions",
  };

  expect(
    enforceRoleAssignmentCapability(
      config,
      roleBinding({
        injectionMethod: "claude-system-prompt",
        mutationMode: "bounded-write",
      }),
    ),
  ).toBe(config);
});

test("no-write assignment fails closed for a provider without a qualified mode", () => {
  expect(() =>
    requiredNoWriteMode(roleBinding({ injectionMethod: "omp-append-system-prompt" })),
  ).toThrow("assignment_capability_boundary_required");
  expect(() =>
    requiredNoWriteMode(roleBinding({ injectionMethod: "grok-acp-session-rules" })),
  ).toThrow("assignment_capability_boundary_required");
});

test("no-write assignment rejects mode and permission escalation", () => {
  const binding = roleBinding({ injectionMethod: "claude-system-prompt" });

  expect(() => assertRoleAssignmentModeAllowed(binding, "bypassPermissions")).toThrow(
    "pinned to provider mode 'default'",
  );
  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(binding, { behavior: "allow" }),
  ).toThrow("cannot approve a permission escalation");
  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(binding, { behavior: "deny" }),
  ).not.toThrow();
});

test("no-write assignment permits answering a provider question without granting capability", () => {
  const binding = roleBinding({ injectionMethod: "claude-system-prompt" });

  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(
      binding,
      { behavior: "allow", updatedInput: { answers: { decision: "stop" } } },
      {
        id: "permission-question",
        provider: "claude",
        name: "AskUserQuestion",
        kind: "question",
        title: "Choose how to continue",
        actions: [],
      },
    ),
  ).not.toThrow();
});

test("no-write Cursor assignment permits exact role-ceiling Paseo MCP transport consent", () => {
  const binding = {
    ...roleBinding({ injectionMethod: "cursor-project-rule-capsule" }),
    roleId: "supervisor",
  } as PersistedRoleBinding;

  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(
      binding,
      { behavior: "allow" },
      {
        id: "permission-1",
        provider: "cursor",
        name: "paseo-beads_status",
        kind: "tool",
        title: "paseo-beads_status",
        actions: [],
      },
    ),
  ).not.toThrow();
  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(
      binding,
      { behavior: "allow" },
      {
        id: "permission-2",
        provider: "cursor",
        name: "run_terminal_command",
        kind: "tool",
        title: "Run terminal command",
        actions: [],
      },
    ),
  ).toThrow("cannot approve a permission escalation");
});

test("no-write Cursor assignment rejects a tool omitted from the immutable role profile", () => {
  const binding = {
    ...roleBinding({ injectionMethod: "cursor-project-rule-capsule" }),
    roleId: "supervisor",
    roleProfile: {
      schemaVersion: 1,
      profileDigest: "a".repeat(64),
      defaults: {},
      allowedTools: ["beads_status"],
      allowedSkills: ["beads-issue-tracker"],
    },
  } as PersistedRoleBinding;

  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(
      binding,
      { behavior: "allow" },
      {
        id: "permission-disabled-tool",
        provider: "cursor",
        name: "paseo-read_room",
        kind: "tool",
        title: "paseo-read_room",
        actions: [],
      },
    ),
  ).toThrow("cannot approve a permission escalation");
});

test("no-write Cursor assignment permits opaque MCP consent only for the role-scoped Paseo server", () => {
  const binding = {
    ...roleBinding({ injectionMethod: "cursor-project-rule-capsule" }),
    roleId: "supervisor",
  } as PersistedRoleBinding;
  const request = {
    id: "permission-opaque-mcp",
    provider: "cursor",
    name: "other",
    kind: "tool" as const,
    title: "MCP: tool",
    actions: [],
    metadata: { transportShadow: "cursor-opaque-mcp" },
  };

  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(binding, { behavior: "allow" }, request, {
      onlyRuntimePaseoMcp: true,
    }),
  ).not.toThrow();
  expect(() =>
    assertRoleAssignmentPermissionResponseAllowed(binding, { behavior: "allow" }, request, {
      onlyRuntimePaseoMcp: false,
    }),
  ).toThrow("cannot approve a permission escalation");
});
