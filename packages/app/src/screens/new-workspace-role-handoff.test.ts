import { describe, expect, test } from "vitest";

import { buildNewWorkspaceRoleHandoff } from "./new-workspace-role-handoff";

describe("new workspace role handoff", () => {
  test("preserves the complete selected role context", () => {
    expect(
      buildNewWorkspaceRoleHandoff({
        roleId: "supervisor",
        assignmentEffect: "read-only",
        beadsIssueIds: ["issue-123"],
      }),
    ).toEqual({
      roleId: "supervisor",
      assignmentEffect: "read-only",
      beadsIssueIds: ["issue-123"],
    });
  });

  test("keeps an ordinary workspace draft unbound", () => {
    expect(
      buildNewWorkspaceRoleHandoff({
        roleId: null,
        assignmentEffect: "read-only",
        beadsIssueIds: [],
      }),
    ).toEqual({});
  });
});
