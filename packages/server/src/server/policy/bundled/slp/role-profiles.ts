import { createHash } from "node:crypto";
import type { AssignmentEffectClass } from "@getpaseo/protocol/assignment-contract";

import {
  PASEO_ROLE_IDS,
  type PaseoRoleId,
  type RoleProfileBindingReceipt,
} from "@getpaseo/protocol/role-binding";
import {
  RoleProfileCatalogSchema,
  RoleProfilePreferencesMapSchema,
  RoleProfilePreferencesSchema,
  type RoleProfileCatalog,
  type RoleProfilePreferences,
  type RoleProfilePreferencesMap,
} from "@getpaseo/protocol/role-profile";

import { getFoundationRoleDefinition } from "./role-definitions.js";
import { loadFoundationSkillPolicy } from "./skill-policy.js";

export const ROLE_PROFILE_POLICY_VERSION = "2";

const READ_ONLY_BROWSER_TOOLS = [
  "browser_list_tabs",
  "browser_snapshot",
  "browser_wait",
  "browser_screenshot",
  "browser_logs",
] as const;

export const ROLE_TOOL_CEILINGS = {
  lead: [
    "list_workspaces",
    "list_workspace_scripts",
    "list_profiles",
    "create_agent",
    "send_agent_prompt",
    "signal_agent",
    "prepare_lead_handoff",
    "transition_lead_handoff",
    "resolve_agent_signal",
    "get_agent_status",
    "get_agent_checkpoint",
    "list_agents",
    "cancel_agent",
    "archive_agent",
    "get_agent_activity",
    "create_room",
    "start_council",
    "record_council_seat",
    "read_room",
    "post_room",
    "beads_status",
    "beads_ready",
    "beads_list",
    "beads_get",
    "beads_create",
    "beads_claim",
    "beads_update",
    "beads_close",
    "beads_add_dependency",
    "beads_prime",
    "read_project_notebook",
    "list_providers",
    "list_models",
    "inspect_provider",
    ...READ_ONLY_BROWSER_TOOLS,
  ],
  peer: [
    "post_room",
    "resolve_agent_signal",
    "get_agent_checkpoint",
    "beads_status",
    "beads_ready",
    "beads_list",
    "beads_get",
    "beads_create",
    "beads_claim",
    "beads_update",
    "beads_add_dependency",
    "beads_prime",
    "read_project_notebook",
    ...READ_ONLY_BROWSER_TOOLS,
  ],
  supervisor: [
    "list_workspaces",
    "list_workspace_scripts",
    "create_agent",
    "send_agent_prompt",
    "get_agent_status",
    "get_agent_checkpoint",
    "list_agents",
    "get_agent_activity",
    "read_room",
    "list_pending_permissions",
    "list_terminals",
    "capture_terminal",
    "list_schedules",
    "inspect_schedule",
    "schedule_logs",
    "list_providers",
    "list_models",
    "inspect_provider",
    "signal_agent",
    "ask_attention_question",
    "resolve_agent_signal",
    "beads_status",
    "beads_ready",
    "beads_list",
    "beads_get",
    "beads_prime",
    "read_project_notebook",
    "append_project_notebook_record",
    ...READ_ONLY_BROWSER_TOOLS,
  ],
} as const satisfies Record<PaseoRoleId, readonly string[]>;

const DEFAULT_DISABLED_ROLE_TOOLS = {
  lead: new Set(["signal_agent", "prepare_lead_handoff", "transition_lead_handoff"]),
  peer: new Set<string>(),
  supervisor: new Set(["create_agent", "send_agent_prompt", "signal_agent"]),
} as const satisfies Record<PaseoRoleId, ReadonlySet<string>>;

export const ROLE_DEFAULT_TOOLS = Object.fromEntries(
  PASEO_ROLE_IDS.map((roleId) => [
    roleId,
    ROLE_TOOL_CEILINGS[roleId].filter((tool) => !DEFAULT_DISABLED_ROLE_TOOLS[roleId].has(tool)),
  ]),
) as Record<PaseoRoleId, string[]>;

export const MANDATORY_ROLE_TOOLS = ["beads_status", "beads_get", "beads_prime"] as const;
export const MANDATORY_ROLE_SKILLS = ["beads-issue-tracker"] as const;

const PEER_MUTATING_BEADS_TOOLS = new Set([
  "beads_create",
  "beads_claim",
  "beads_update",
  "beads_add_dependency",
  "beads_close",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSelectionWithinCeiling(input: {
  roleId: PaseoRoleId;
  kind: "tool" | "skill";
  selected: readonly string[];
  ceiling: readonly string[];
  mandatory: readonly string[];
}): void {
  const ceiling = new Set(input.ceiling);
  const unknown = input.selected.filter((entry) => !ceiling.has(entry));
  if (unknown.length > 0) {
    throw new Error(
      `Role profile '${input.roleId}' cannot enable ${input.kind}(s) outside the Foundation ceiling: ${unknown.join(", ")}`,
    );
  }
  const selected = new Set(input.selected);
  const missing = input.mandatory.filter((entry) => !selected.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Role profile '${input.roleId}' cannot disable mandatory ${input.kind}(s): ${missing.join(", ")}`,
    );
  }
}

function canonicalSelection(
  configured: readonly string[] | undefined,
  ceiling: readonly string[],
): string[] {
  if (!configured) return [...ceiling];
  const selected = new Set(configured);
  return ceiling.filter((entry) => selected.has(entry));
}

function roleSkillCeiling(roleId: PaseoRoleId): string[] {
  const policy = loadFoundationSkillPolicy(roleId);
  if (policy.status !== "bound") {
    throw new Error(
      `foundation_skill_admission_required: role bundle is ${policy.status} at ${policy.manifestPath}`,
    );
  }
  return [...policy.enabledNames].sort();
}

export function materializeRoleProfileBindingReceipt(
  roleId: PaseoRoleId,
  input: RoleProfilePreferences | undefined,
  assignmentEffectClass?: AssignmentEffectClass,
): RoleProfileBindingReceipt {
  const preferences = RoleProfilePreferencesSchema.parse(input ?? {});
  const toolCeiling = ROLE_TOOL_CEILINGS[roleId];
  const skillCeiling = roleSkillCeiling(roleId);
  const selectedTools = canonicalSelection(
    preferences.allowedTools,
    preferences.allowedTools ? toolCeiling : ROLE_DEFAULT_TOOLS[roleId],
  );
  const allowedTools =
    roleId === "peer" && assignmentEffectClass === "read-only"
      ? selectedTools.filter((tool) => !PEER_MUTATING_BEADS_TOOLS.has(tool))
      : selectedTools;
  const allowedSkills = canonicalSelection(preferences.allowedSkills, skillCeiling);

  assertSelectionWithinCeiling({
    roleId,
    kind: "tool",
    selected: preferences.allowedTools ?? allowedTools,
    ceiling: toolCeiling,
    mandatory: MANDATORY_ROLE_TOOLS,
  });
  assertSelectionWithinCeiling({
    roleId,
    kind: "skill",
    selected: preferences.allowedSkills ?? allowedSkills,
    ceiling: skillCeiling,
    mandatory: MANDATORY_ROLE_SKILLS,
  });

  const defaults = preferences.defaults ?? {};
  const canonical = JSON.stringify({
    schemaVersion: 1,
    roleId,
    defaults,
    allowedTools,
    allowedSkills,
  });
  return {
    schemaVersion: 1,
    profileDigest: sha256(canonical),
    defaults,
    allowedTools,
    allowedSkills,
  };
}

export function validateRoleProfilePreferencesMap(
  input: RoleProfilePreferencesMap,
): RoleProfilePreferencesMap {
  const parsed = RoleProfilePreferencesMapSchema.parse(input);
  for (const roleId of PASEO_ROLE_IDS) {
    if (parsed[roleId]) {
      materializeRoleProfileBindingReceipt(roleId, parsed[roleId]);
    }
  }
  return parsed;
}

export function buildRoleProfileCatalog(input: RoleProfilePreferencesMap): RoleProfileCatalog {
  const preferences = validateRoleProfilePreferencesMap(input);
  return RoleProfileCatalogSchema.parse({
    profiles: PASEO_ROLE_IDS.map((roleId) => {
      const definition = getFoundationRoleDefinition(roleId);
      const rolePreferences = preferences[roleId] ?? {};
      return {
        roleId,
        label: definition.label,
        description: definition.description,
        definitionVersion: definition.version,
        definitionDigest: sha256(definition.instructions),
        instructions: definition.instructions,
        toolCeiling: [...ROLE_TOOL_CEILINGS[roleId]],
        mandatoryTools: [...MANDATORY_ROLE_TOOLS],
        skillCeiling: roleSkillCeiling(roleId),
        mandatorySkills: [...MANDATORY_ROLE_SKILLS],
        preferences: rolePreferences,
        effective: materializeRoleProfileBindingReceipt(roleId, rolePreferences),
      };
    }),
  });
}
