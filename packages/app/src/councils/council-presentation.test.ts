import { describe, expect, it } from "vitest";
import type { CouncilSeatRole } from "@getpaseo/protocol/council/types";
import type { CouncilAgentSource, CouncilSeat } from "./model";
import { councilHeroSubtitle, councilSeatModelLabel } from "./council-presentation";

const NOW = new Date("2026-08-10T10:00:00.000Z");

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
    lastActivityAt: NOW,
    ...overrides,
  };
}

function makeSeat(role: CouncilSeatRole, overrides: Partial<CouncilSeat> = {}): CouncilSeat {
  return {
    agentId: role,
    agent: makeAgent(role),
    role,
    round: "1",
    phase: "sealed",
    integrity: "unspecified",
    disposition: null,
    reportReceipt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("councilHeroSubtitle", () => {
  it("reflects a single-seat lens Council as Reviewer-only, not Architect + Reviewer", () => {
    const subtitle = councilHeroSubtitle({ seats: [makeSeat("reviewer")] });
    expect(subtitle).toBe("One accountable Lead. Reviewer. No vote.");
  });

  it("reflects an Architect + Reviewer debate Council", () => {
    const subtitle = councilHeroSubtitle({
      seats: [makeSeat("architect"), makeSeat("reviewer")],
    });
    expect(subtitle).toBe("One accountable Lead. Solution Architect + Reviewer. No vote.");
  });

  it("includes Scout when present and orders roles canonically", () => {
    const subtitle = councilHeroSubtitle({
      seats: [makeSeat("reviewer"), makeSeat("scout"), makeSeat("architect")],
    });
    expect(subtitle).toBe("One accountable Lead. Scout + Solution Architect + Reviewer. No vote.");
  });

  it("deduplicates repeated roles across rounds", () => {
    const subtitle = councilHeroSubtitle({
      seats: [makeSeat("reviewer", { round: "1" }), makeSeat("reviewer", { round: "2" })],
    });
    expect(subtitle).toBe("One accountable Lead. Reviewer. No vote.");
  });

  it("excludes redundant replacement seats from the role summary", () => {
    const subtitle = councilHeroSubtitle({
      seats: [makeSeat("reviewer"), makeSeat("architect", { integrity: "redundant" })],
    });
    expect(subtitle).toBe("One accountable Lead. Reviewer. No vote.");
  });
});

describe("councilSeatModelLabel", () => {
  it("labels a seat with an agent projection by model", () => {
    const seat = makeSeat("reviewer");
    expect(councilSeatModelLabel(seat)).toBe("gpt-5");
  });

  it("labels a seat that was never launched (no agentId) as Not launched", () => {
    const seat = makeSeat("reviewer", { agentId: null, agent: null });
    expect(councilSeatModelLabel(seat)).toBe("Not launched");
  });

  it("distinguishes an archived/unloaded seat (agentId present, agent missing) from never launched", () => {
    const seat = makeSeat("reviewer", { agent: null });
    expect(seat.agentId).not.toBeNull();
    expect(councilSeatModelLabel(seat)).toBe("Agent unavailable");
  });

  it("falls back to provider when the agent has no model", () => {
    const seat = makeSeat("reviewer", { agent: makeAgent("reviewer", { model: null }) });
    expect(councilSeatModelLabel(seat)).toBe("codex");
  });
});
