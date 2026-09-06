import { describe, expect, test } from "vitest";

import {
  ROLE_PROFILE_POLICY_VERSION,
  ROLE_TOOL_CEILINGS,
  materializeRoleProfileBindingReceipt,
} from "./role-profiles.js";

describe("SLP role-profile checkpoint admission", () => {
  test("admits get_agent_checkpoint in every role ceiling", () => {
    expect(ROLE_PROFILE_POLICY_VERSION).toBe("2");
    for (const roleId of ["lead", "peer", "supervisor"] as const) {
      expect(ROLE_TOOL_CEILINGS[roleId]).toContain("get_agent_checkpoint");
    }
  });

  test("keeps checkpoint admission inside the selected role ceiling", () => {
    for (const roleId of ["lead", "peer", "supervisor"] as const) {
      const receipt = materializeRoleProfileBindingReceipt(roleId, {
        allowedTools: ["get_agent_checkpoint", "beads_status", "beads_get", "beads_prime"],
      });
      expect(receipt.allowedTools).toContain("get_agent_checkpoint");
      expect(receipt.allowedTools.every((tool) => ROLE_TOOL_CEILINGS[roleId].includes(tool))).toBe(
        true,
      );
    }
  });
});
