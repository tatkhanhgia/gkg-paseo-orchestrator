import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@getpaseo/protocol/chat/types";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  describeRoomPlacement,
  findActiveRoomMention,
  insertRoomMention,
  mergeChatMessages,
} from "./model";

const workspace: WorkspaceDescriptor = {
  id: "wks_1",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo",
  projectKind: "git",
  workspaceKind: "local_checkout",
  name: "main",
  status: "done",
  statusEnteredAt: null,
  archivingAt: null,
  createdAt: null,
  lastUserMessageAt: null,
  diffStat: null,
  scripts: [],
};

function message(id: string, createdAt: string): ChatMessage {
  return {
    id,
    roomId: "room-1",
    authorAgentId: "agent-1",
    body: id,
    replyToMessageId: null,
    mentionAgentIds: [],
    createdAt,
  };
}

describe("room model", () => {
  it("merges realtime messages without duplicates and keeps wire order", () => {
    const first = message("first", "2026-08-04T01:00:00.000Z");
    const second = message("second", "2026-08-04T01:01:00.000Z");
    expect(mergeChatMessages([first], [second, first])).toEqual([first, second]);
  });

  it("finds the mention at the active cursor and ignores email-like text", () => {
    expect(findActiveRoomMention("ask @peer", 9)).toEqual({ start: 4, end: 9, query: "peer" });
    expect(findActiveRoomMention("mail a@b.com", 12)).toBeNull();
  });

  it("inserts a canonical agent id and preserves text after the cursor", () => {
    expect(insertRoomMention("ask @pe now", 7, "peer-agent")).toEqual({
      text: "ask @peer-agent now",
      cursor: 16,
    });
  });

  it("labels a legacy host-level room without guessing a workspace", () => {
    expect(describeRoomPlacement({}, null)).toEqual({
      text: "Host-level (legacy)",
      legacy: true,
    });
    expect(describeRoomPlacement({}, workspace)).toEqual({
      text: "Host-level (legacy)",
      legacy: true,
    });
  });

  it("flags a scoped room whose workspace no longer resolves, preserving the exact workspace id", () => {
    expect(describeRoomPlacement({ workspaceId: "wks_1" }, null)).toEqual({
      text: "Unavailable workspace (workspace: wks_1)",
      legacy: true,
    });
  });

  it("flags an unresolved scoped room with both labeled project and workspace ids", () => {
    expect(describeRoomPlacement({ workspaceId: "wks_1", projectId: "prj_1" }, null)).toEqual({
      text: "Unavailable workspace (project: prj_1, workspace: wks_1)",
      legacy: true,
    });
  });

  it("shows human-readable project / workspace placement for a scoped room", () => {
    expect(describeRoomPlacement({ workspaceId: "wks_1" }, workspace)).toEqual({
      text: "Project / main",
      legacy: false,
    });
  });
});
