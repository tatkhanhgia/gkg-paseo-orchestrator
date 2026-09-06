import { describe, expect, test, vi } from "vitest";
import type { BeadsIssue } from "@getpaseo/protocol/beads/rpc-schemas";

import {
  adaptBeadsCheckpoint,
  readBeadsCheckpoint,
  type CheckpointBeadsTargetBinding,
} from "./agent-checkpoint-adapter.js";

const issue: BeadsIssue = {
  id: "issue-1",
  title: "Bound checkpoint",
  status: "in_progress",
  priority: 2,
  issue_type: "task",
  assignee: "agent-1",
};

const binding: CheckpointBeadsTargetBinding = {
  issueId: "issue-1",
  targetAgentId: "agent-1",
};

describe("trusted Beads checkpoint adapter", () => {
  test("requires the exact issue-to-target binding", () => {
    expect(
      adaptBeadsCheckpoint({
        issue,
        targetAgentId: "agent-1",
        binding: { ...binding, targetAgentId: "agent-2" },
        dependencies: { complete: true, openDependencyCount: 3 },
      }),
    ).toEqual({
      accessible: false,
      reason: "exact Beads issue-to-target binding is unavailable",
    });
  });

  test("keeps omitted or incomplete dependency data unknown", () => {
    expect(
      adaptBeadsCheckpoint({
        issue,
        targetAgentId: "agent-1",
        binding,
      }),
    ).toMatchObject({
      accessible: true,
      issue: {
        boundTargetAgentId: "agent-1",
        openDependencyCount: null,
        dependencyDataComplete: false,
      },
    });
    expect(
      adaptBeadsCheckpoint({
        issue,
        targetAgentId: "agent-1",
        binding,
        dependencies: { complete: false, openDependencyCount: 99 },
      }),
    ).toMatchObject({
      issue: { openDependencyCount: null, dependencyDataComplete: false },
    });
  });

  test("reads the exact bound issue through the production service boundary", async () => {
    const get = vi.fn(async (_project: { projectId: string; actor: string }, issueId: string) => {
      expect(issueId).toBe("issue-1");
      return issue;
    });
    const result = await readBeadsCheckpoint({
      service: { get },
      project: { projectId: "project-1", actor: "agent-1" },
      targetAgentId: "agent-1",
      binding,
      dependencies: { complete: true, openDependencyCount: 0 },
    });

    expect(get).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      accessible: true,
      issue: {
        issueId: "issue-1",
        boundTargetAgentId: "agent-1",
        openDependencyCount: 0,
        dependencyDataComplete: true,
      },
    });
  });
});
