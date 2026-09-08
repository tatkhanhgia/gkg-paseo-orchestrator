import { expect, test } from "vitest";

import {
  resolveFinishNotificationContent,
  type FinishNotificationCouncilSeatLookup,
} from "./finish-notification-policy.js";

const BASE = {
  childAgentId: "child-1",
  title: "Child Agent",
  reason: "finished" as const,
};

test("not_council includes the full last assistant message", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    lastAssistantMessage: "The conclusion is option A.",
    councilSeat: { status: "not_council" },
  });
  expect(body).toContain("The conclusion is option A.");
  expect(body).not.toContain("<council-seat>");
});

test("a sealed seat is receipt-only: no conclusion content, only case/seat/terminal/receipt pointer", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    lastAssistantMessage: "Recommendation: choose option A because of evidence X.",
    councilSeat: {
      status: "found",
      seat: {
        caseId: "case-1",
        seatId: "child-1",
        phase: "sealed",
        terminal: true,
        receiptPointer: "room-1:msg-42",
      },
    },
  });
  expect(body).not.toContain("Recommendation");
  expect(body).not.toContain("option A");
  expect(body).toContain("Case: case-1");
  expect(body).toContain("Seat: child-1");
  expect(body).toContain("Terminal: true");
  expect(body).toContain("Receipt: room-1:msg-42");
});

test("a seat past sealed (review/audit/verdict) reveals content even if the case were mixed-phase", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    lastAssistantMessage: "Recommendation: choose option A.",
    councilSeat: {
      status: "found",
      seat: {
        caseId: "case-1",
        seatId: "child-1",
        phase: "review",
        terminal: true,
        receiptPointer: "room-1:msg-42",
      },
    },
  });
  expect(body).toContain("Recommendation: choose option A.");
});

test("mixed-phase case: this seat's own sealed phase gates content even though other seats already advanced", () => {
  // Simulates council-case-store.ts's maxPhase: the case-wide phase could
  // already read "review" from a sibling seat while THIS seat is sealed.
  // The projection must never be built from the case-wide phase.
  const otherSeatAlreadyAdvancedCaseWide = "review";
  void otherSeatAlreadyAdvancedCaseWide; // documents the scenario this test defends against
  const lookup: FinishNotificationCouncilSeatLookup = {
    status: "found",
    seat: {
      caseId: "case-1",
      seatId: "child-1",
      phase: "sealed",
      terminal: false,
      receiptPointer: null,
    },
  };
  const body = resolveFinishNotificationContent({
    ...BASE,
    lastAssistantMessage: "The verdict should be B.",
    councilSeat: lookup,
  });
  expect(body).not.toContain("The verdict should be B.");
  expect(body).toContain("Receipt: pending");
});

test("unknown/ambiguous canonical lookup fails closed: withholds content like a sealed seat", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    lastAssistantMessage: "The conclusion is option A.",
    councilSeat: { status: "unknown" },
  });
  expect(body).not.toContain("option A");
  expect(body).toContain("Failing closed");
});

test("needs permission includes a machine-readable permission-request block regardless of council status", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    reason: "needs permission",
    lastAssistantMessage: null,
    permissionRequest: {
      id: "perm-1",
      provider: "codex",
      kind: "tool",
      name: "Run command",
      description: "rm -rf /tmp/x",
      input: { command: "rm -rf /tmp/x" },
    },
    councilSeat: { status: "not_council" },
  });
  expect(body).toContain("<permission-request>");
  expect(body).toContain('"requestId": "perm-1"');
});

test("needs permission on a sealed seat retains only the bounded agentId/requestId locator, never name/description/input", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    reason: "needs permission",
    lastAssistantMessage: "Recommendation: choose option A because of evidence X.",
    permissionRequest: {
      id: "perm-1",
      provider: "codex",
      kind: "tool",
      name: "Run command",
      description: "rm -rf /tmp/sensitive-project-plan",
      input: { command: "rm -rf /tmp/sensitive-project-plan", flag: "--secret-arg" },
    },
    councilSeat: {
      status: "found",
      seat: {
        caseId: "case-1",
        seatId: "child-1",
        phase: "sealed",
        terminal: false,
        receiptPointer: null,
      },
    },
  });
  expect(body).toContain("<permission-request>");
  expect(body).toContain('"requestId": "perm-1"');
  expect(body).not.toContain('"request":');
  expect(body).not.toContain("Run command");
  expect(body).not.toContain("rm -rf /tmp/sensitive-project-plan");
  expect(body).not.toContain("--secret-arg");
  expect(body).not.toContain("Recommendation");
});

test("needs permission with unknown/ambiguous council status retains only the bounded locator, never name/description/input", () => {
  const body = resolveFinishNotificationContent({
    ...BASE,
    reason: "needs permission",
    lastAssistantMessage: "The conclusion is option A.",
    permissionRequest: {
      id: "perm-2",
      provider: "claude",
      kind: "tool",
      name: "Read file",
      description: "cat /etc/shadow",
      input: { path: "/etc/shadow" },
    },
    councilSeat: { status: "unknown" },
  });
  expect(body).toContain("<permission-request>");
  expect(body).toContain('"requestId": "perm-2"');
  expect(body).not.toContain("Read file");
  expect(body).not.toContain("/etc/shadow");
  expect(body).not.toContain("option A");
});

test("long last assistant message is truncated with an explicit marker", () => {
  const long = "x".repeat(5000);
  const body = resolveFinishNotificationContent({
    ...BASE,
    lastAssistantMessage: long,
    councilSeat: { status: "not_council" },
  });
  expect(body).toContain("[truncated 1000 chars");
});

test("is pure: identical input produces identical output", () => {
  const input = {
    ...BASE,
    lastAssistantMessage: "same",
    councilSeat: { status: "not_council" } as const,
  };
  expect(resolveFinishNotificationContent(input)).toBe(resolveFinishNotificationContent(input));
});
