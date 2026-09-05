import { describe, expect, test } from "vitest";

import { buildNewWorkspaceRoleHandoff } from "./new-workspace-role-handoff";

describe("new workspace role handoff", () => {
  test("preserves the complete selected role context", () => {
    expect(
      buildNewWorkspaceRoleHandoff({
        roleId: "peer",
        assignmentEffect: "mutating",
        beadsIssueIds: ["issue-123"],
        externalEffects: ["staging API"],
      }),
    ).toEqual({
      roleId: "peer",
      assignmentEffect: "mutating",
      beadsIssueIds: ["issue-123"],
      externalEffects: ["staging API"],
    });
  });

  test("keeps an ordinary workspace draft unbound", () => {
    expect(
      buildNewWorkspaceRoleHandoff({
        roleId: null,
        assignmentEffect: "read-only",
        beadsIssueIds: [],
        externalEffects: [],
      }),
    ).toEqual({});
  });
});
