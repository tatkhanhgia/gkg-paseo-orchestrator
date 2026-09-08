import { describe, expect, test } from "vitest";

import {
  MANDATORY_ROLE_SKILLS,
  MANDATORY_ROLE_TOOLS,
  buildRoleProfileCatalog,
  materializeRoleProfileBindingReceipt,
  validateRoleProfilePreferencesMap,
} from "./role-profiles.js";

describe("Foundation role profiles", () => {
  test("projects the three canonical roles and their current ceilings", () => {
    const catalog = buildRoleProfileCatalog({});

    expect(catalog.profiles.map((profile) => profile.roleId)).toEqual([
      "lead",
      "peer",
      "supervisor",
    ]);
    expect(catalog.profiles.find((profile) => profile.roleId === "peer")?.toolCeiling).toEqual([
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
      "browser_list_tabs",
      "browser_snapshot",
      "browser_wait",
      "browser_screenshot",
      "browser_logs",
    ]);
    expect(catalog.profiles.find((profile) => profile.roleId === "lead")?.toolCeiling).toContain(
      "list_profiles",
    );
    expect(
      catalog.profiles.find((profile) => profile.roleId === "peer")?.toolCeiling,
    ).not.toContain("list_profiles");
    expect(
      catalog.profiles.find((profile) => profile.roleId === "supervisor")?.toolCeiling,
    ).not.toContain("list_profiles");
    expect(
      catalog.profiles.find((profile) => profile.roleId === "supervisor")?.toolCeiling,
    ).toContain("read_room");
    expect(
      catalog.profiles.find((profile) => profile.roleId === "supervisor")?.toolCeiling,
    ).toEqual(
      expect.arrayContaining(["create_agent", "send_agent_prompt", "ask_attention_question"]),
    );
    for (const profile of catalog.profiles) {
      if (profile.roleId === "lead" || profile.roleId === "supervisor") {
        expect(profile.effective.allowedTools).not.toEqual(profile.toolCeiling);
      } else {
        expect(profile.effective.allowedTools).toEqual(profile.toolCeiling);
      }
      expect(profile.effective.allowedSkills).toEqual(profile.skillCeiling);
      expect(profile.instructions).toContain("Paseo");
    }
    expect(
      catalog.profiles.find((profile) => profile.roleId === "lead")?.effective.allowedTools,
    ).toEqual(
      expect.not.arrayContaining([
        "signal_agent",
        "prepare_lead_handoff",
        "transition_lead_handoff",
      ]),
    );
    expect(
      catalog.profiles.find((profile) => profile.roleId === "lead")?.effective.allowedTools,
    ).toContain("resolve_agent_signal");
    expect(
      catalog.profiles.find((profile) => profile.roleId === "peer")?.effective.allowedTools,
    ).toContain("resolve_agent_signal");
    expect(
      catalog.profiles.find((profile) => profile.roleId === "supervisor")?.effective.allowedTools,
    ).toEqual(expect.not.arrayContaining(["create_agent", "send_agent_prompt", "signal_agent"]));
    expect(
      catalog.profiles.find((profile) => profile.roleId === "supervisor")?.effective.allowedTools,
    ).toEqual(expect.arrayContaining(["ask_attention_question", "resolve_agent_signal"]));
  });

  test("materializes a deterministic, narrower immutable receipt", () => {
    const preferences = {
      defaults: { provider: "codex", model: "gpt-5.4" },
      allowedTools: [...MANDATORY_ROLE_TOOLS],
      allowedSkills: [...MANDATORY_ROLE_SKILLS],
    };

    const first = materializeRoleProfileBindingReceipt("peer", preferences);
    const second = materializeRoleProfileBindingReceipt("peer", preferences);

    expect(first).toEqual(second);
    expect(first.allowedTools).toEqual([...MANDATORY_ROLE_TOOLS]);
    expect(first.allowedSkills).toEqual([...MANDATORY_ROLE_SKILLS]);
    expect(first.profileDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects ceiling expansion and mandatory capability removal", () => {
    expect(() =>
      validateRoleProfilePreferencesMap({
        peer: {
          allowedTools: [...MANDATORY_ROLE_TOOLS, "create_agent"],
          allowedSkills: [...MANDATORY_ROLE_SKILLS],
        },
      }),
    ).toThrow("outside the Foundation ceiling");

    expect(() =>
      validateRoleProfilePreferencesMap({
        lead: {
          allowedTools: [],
          allowedSkills: [...MANDATORY_ROLE_SKILLS],
        },
      }),
    ).toThrow("cannot disable mandatory tool");
  });

  test("allows explicit opt-in inside the full role ceiling", () => {
    const receipt = materializeRoleProfileBindingReceipt("supervisor", {
      allowedTools: [...MANDATORY_ROLE_TOOLS, "signal_agent", "create_agent", "send_agent_prompt"],
      allowedSkills: [...MANDATORY_ROLE_SKILLS],
    });

    expect(receipt.allowedTools).toEqual(
      expect.arrayContaining(["signal_agent", "create_agent", "send_agent_prompt"]),
    );
    const leadReceipt = materializeRoleProfileBindingReceipt("lead", {
      allowedTools: [
        ...MANDATORY_ROLE_TOOLS,
        "signal_agent",
        "prepare_lead_handoff",
        "transition_lead_handoff",
      ],
      allowedSkills: [...MANDATORY_ROLE_SKILLS],
    });
    expect(leadReceipt.allowedTools).toEqual(
      expect.arrayContaining(["signal_agent", "prepare_lead_handoff", "transition_lead_handoff"]),
    );
    expect(() =>
      materializeRoleProfileBindingReceipt("supervisor", {
        allowedTools: [...MANDATORY_ROLE_TOOLS, "transition_lead_handoff"],
        allowedSkills: [...MANDATORY_ROLE_SKILLS],
      }),
    ).toThrow("outside the Foundation ceiling");
  });
});
