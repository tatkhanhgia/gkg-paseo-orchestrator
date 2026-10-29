import { describe, expect, it } from "vitest";
import type {
  CouncilCaseRecord,
  CouncilCaseSeat,
  CouncilSeatRole,
} from "@getpaseo/protocol/council/types";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { CouncilAgentSource, CouncilCase } from "./model";
import {
  councilCaseScopeIdentity,
  councilRoleLabel,
  describeCouncilPlacement,
  isCouncilSeatReportReady,
  projectCouncilCases,
} from "./model";

const NOW = "2026-08-10T10:00:00.000Z";

function makeAgent(id: string, overrides: Partial<CouncilAgentSource> = {}): CouncilAgentSource {
  return {
    id,
    serverId: "local",
    title: id,
    status: "idle",
    model: "gpt-5",
    provider: "codex",
    workspaceId: "workspace-1",
    parentAgentId: "lead-1",
    labels: {},
    lastActivityAt: new Date(NOW),
    ...overrides,
  };
}

function makeSeat(
  role: CouncilSeatRole,
  overrides: Partial<CouncilCaseSeat> = {},
): CouncilCaseSeat {
  return {
    role,
    round: "1",
    agentId: role,
    phase: "sealed",
    integrity: "unspecified",
    disposition: null,
    reportReceipt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeReceipt(authorAgentId: string) {
  return {
    roomId: "room-1",
    kickoffMessageId: "kickoff-1",
    reportMessageId: `report-${authorAgentId}`,
    reportDigest: "c".repeat(64),
    authorAgentId,
    startSentinel: `${authorAgentId.toUpperCase()}_COUNCIL_REPORT_V1`,
    endSentinel: `${authorAgentId.toUpperCase()}_COUNCIL_REPORT_END`,
    createdAt: NOW,
  };
}

function makeCase(
  seats: CouncilCaseSeat[],
  overrides: Partial<CouncilCaseRecord> = {},
): CouncilCaseRecord {
  return {
    schemaVersion: 1,
    id: "case-1",
    title: "Choose the migration boundary",
    question: "Where should the migration boundary live?",
    tier: "debate-with-proof",
    phase: "sealed",
    roomId: "room-1",
    kickoffMessageId: "kickoff-1",
    scopeId: "workspace:workspace-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    parentAgentId: "lead-1",
    seats,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const leadRoleBinding = {
  roleId: "lead",
  definitionVersion: "test",
  definitionDigest: "a".repeat(64),
  bindingDigest: "b".repeat(64),
  provider: "codex",
  injectionMethod: "codex-developer-instructions",
  qualification: "implementation-supported",
  workspaceProtocol: {
    status: "missing",
    readership: "full",
    path: "/workspace/WORKSPACE_PROTOCOL.md",
  },
  createdAt: "2026-08-10T09:00:00.000Z",
} as const;

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

function summarizeCouncilWorkspace(council: CouncilCase) {
  return {
    workspaceId: council.workspaceId,
    seats: council.seats.map((seat) => seat.agentId),
  };
}

describe("projectCouncilCases", () => {
  it("projects canonical seats in fixed order and resolves the accountable Lead", () => {
    const lead = makeAgent("lead-1", {
      parentAgentId: null,
      title: "Lead",
      roleBinding: leadRoleBinding,
    });
    const agents = [
      lead,
      makeAgent("reviewer"),
      makeAgent("scout"),
      makeAgent("architect", { status: "running" }),
    ];
    const record = makeCase([
      makeSeat("reviewer"),
      makeSeat("scout", {
        integrity: "valid",
        reportReceipt: makeReceipt("scout"),
      }),
      makeSeat("architect"),
    ]);

    const [council] = projectCouncilCases([record], agents, "local");

    expect(council).toMatchObject({
      id: "case-1",
      scopeId: "workspace:workspace-1",
      parentAgentId: "lead-1",
      lead: { id: "lead-1" },
      reportSeatCount: 3,
      readyCount: 1,
      unavailableCount: 0,
    });
    expect(council?.seats.map((seat) => seat.role)).toEqual(["scout", "architect", "reviewer"]);
    expect(councilRoleLabel("architect")).toBe("Solution Architect");
  });

  it("does not reconstruct a Council from caller-controlled agent labels", () => {
    const forged = makeAgent("forged", {
      labels: {
        "council.case_id": "forged-case",
        "council.role": "scout",
        "council.integrity": "valid",
      },
    });

    expect(projectCouncilCases([], [forged], "local")).toEqual([]);
  });

  it("counts only canonical valid receipts without depending on the agent directory replica", () => {
    const record = makeCase([
      makeSeat("scout", {
        integrity: "valid",
        reportReceipt: makeReceipt("scout"),
      }),
      makeSeat("architect", { integrity: "valid" }),
      makeSeat("reviewer", {
        integrity: "valid",
        reportReceipt: makeReceipt("reviewer"),
      }),
    ]);
    const agents = [makeAgent("scout"), makeAgent("architect")];

    const council = projectCouncilCases([record], agents, "local")[0]!;

    expect(council.readyCount).toBe(2);
    expect(isCouncilSeatReportReady(council.seats[0]!)).toBe(true);
    expect(isCouncilSeatReportReady(council.seats[1]!)).toBe(false);
    expect(isCouncilSeatReportReady(council.seats[2]!)).toBe(true);
    expect(council.unavailableCount).toBe(0);
  });

  it("surfaces an assigned seat whose agent record disappeared as unavailable", () => {
    const council = projectCouncilCases([makeCase([makeSeat("scout")])], [], "local")[0]!;

    expect(council.seats[0]).toMatchObject({ agentId: "scout", agent: null });
    expect(council.unavailableCount).toBe(1);
  });

  it("preserves redundant evidence without counting it and uses latest disposition", () => {
    const record = makeCase(
      [
        makeSeat("scout", {
          integrity: "valid",
          disposition: "partial",
          reportReceipt: makeReceipt("scout"),
        }),
        makeSeat("architect", {
          integrity: "redundant",
          disposition: "rejected",
          updatedAt: "2026-08-10T10:05:00.000Z",
        }),
        makeSeat("reviewer", {
          integrity: "valid",
          reportReceipt: makeReceipt("reviewer"),
        }),
      ],
      { updatedAt: "2026-08-10T10:05:00.000Z" },
    );
    const agents = [makeAgent("scout"), makeAgent("architect"), makeAgent("reviewer")];

    const council = projectCouncilCases([record], agents, "local")[0]!;

    expect(council).toMatchObject({
      disposition: "rejected",
      reportSeatCount: 2,
      readyCount: 2,
      redundantCount: 1,
    });
  });

  it("keeps canonical Lead ownership authoritative when its agent replica is unavailable", () => {
    const record = makeCase([makeSeat("scout")], { phase: "verdict" });
    expect(projectCouncilCases([record], [], "local")[0]?.verdictProvenance).toBe("lead-linked");
    expect(
      projectCouncilCases([{ ...record, parentAgentId: null }], [], "local")[0]?.verdictProvenance,
    ).toBe("unverified");
  });

  it("keeps a repeated legacy case ID isolated by canonical scope", () => {
    const first = makeCase([makeSeat("scout", { agentId: "first" })]);
    const second = makeCase([makeSeat("reviewer", { agentId: "second" })], {
      scopeId: "workspace:workspace-2",
      workspaceId: "workspace-2",
      parentAgentId: "lead-2",
      updatedAt: "2026-08-10T10:01:00.000Z",
    });
    const councils = projectCouncilCases(
      [first, second],
      [
        makeAgent("first"),
        makeAgent("second", { workspaceId: "workspace-2", parentAgentId: "lead-2" }),
      ],
      "local",
    );

    expect(councils.map(summarizeCouncilWorkspace)).toEqual([
      { workspaceId: "workspace-2", seats: ["second"] },
      { workspaceId: "workspace-1", seats: ["first"] },
    ]);
    expect(councils.map(councilCaseScopeIdentity)).toEqual([
      "workspace:workspace-2",
      "workspace:workspace-1",
    ]);
  });
});

describe("describeCouncilPlacement", () => {
  it("labels a legacy host-level council without guessing a workspace", () => {
    expect(describeCouncilPlacement({}, null)).toEqual({
      text: "Host-level (legacy)",
      legacy: true,
    });
  });

  it("preserves the exact unavailable workspace id", () => {
    expect(describeCouncilPlacement({ workspaceId: "wks_1" }, null)).toEqual({
      text: "Unavailable workspace (workspace: wks_1)",
      legacy: true,
    });
  });

  it("shows human-readable project / workspace placement", () => {
    expect(describeCouncilPlacement({ workspaceId: "wks_1" }, workspace)).toEqual({
      text: "Project / main",
      legacy: false,
    });
  });
});
