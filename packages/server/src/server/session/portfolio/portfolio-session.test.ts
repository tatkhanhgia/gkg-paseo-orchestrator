import { describe, expect, it, vi } from "vitest";

import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

import type { PortfolioService } from "../../portfolio/portfolio-service.js";
import { PortfolioServiceError } from "../../portfolio/portfolio-service.js";
import { PortfolioSession } from "./portfolio-session.js";

function portfolio(overrides: Partial<ReturnType<typeof basePortfolio>> = {}) {
  return { ...basePortfolio(), ...overrides };
}

function basePortfolio() {
  return {
    id: "pf_0123456789abcdef",
    name: "Core apps",
    projectIds: [] as string[],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    archivedAt: null,
  };
}

function harness(serviceOverrides: Partial<PortfolioService> = {}) {
  const messages: SessionOutboundMessage[] = [];
  const service = {
    list: vi.fn().mockResolvedValue([portfolio()]),
    get: vi.fn().mockResolvedValue(portfolio()),
    create: vi.fn().mockResolvedValue(portfolio({ name: "New portfolio" })),
    addProject: vi.fn().mockResolvedValue(portfolio({ projectIds: ["prj_alpha"] })),
    removeProject: vi.fn().mockResolvedValue(portfolio()),
    archive: vi.fn().mockResolvedValue(portfolio({ archivedAt: "2026-08-15T01:00:00.000Z" })),
    ...serviceOverrides,
  };
  const session = new PortfolioSession({
    host: { emit: (message) => messages.push(message) },
    service: service as unknown as PortfolioService,
  });
  return { session, service, messages };
}

describe("PortfolioSession", () => {
  it("returns portfolios under the response payload with requestId", async () => {
    const test = harness();

    await test.session.handleList({
      type: "portfolio.list.request",
      requestId: "list-1",
    });

    expect(test.messages).toEqual([
      {
        type: "portfolio.list.response",
        payload: {
          requestId: "list-1",
          portfolios: [portfolio()],
        },
      },
    ]);
  });

  it("routes service failures through rpc_error with stable codes", async () => {
    const test = harness({
      get: vi.fn().mockRejectedValue(new PortfolioServiceError("portfolio_not_found", "missing")),
    });

    await test.session.handleGet({
      type: "portfolio.get.request",
      requestId: "get-1",
      portfolioId: "pf_missing",
    });

    expect(test.messages).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "get-1",
          requestType: "portfolio.get.request",
          error: "missing",
          code: "portfolio_not_found",
        },
      },
    ]);
  });

  it("dispatches create, membership, and archive RPCs", async () => {
    const test = harness();

    await test.session.handleCreate({
      type: "portfolio.create.request",
      requestId: "create-1",
      name: "New portfolio",
    });
    await test.session.handleProjectAdd({
      type: "portfolio.project.add.request",
      requestId: "add-1",
      portfolioId: "pf_0123456789abcdef",
      projectId: "prj_alpha",
    });
    await test.session.handleProjectRemove({
      type: "portfolio.project.remove.request",
      requestId: "remove-1",
      portfolioId: "pf_0123456789abcdef",
      projectId: "prj_alpha",
    });
    await test.session.handleArchive({
      type: "portfolio.archive.request",
      requestId: "archive-1",
      portfolioId: "pf_0123456789abcdef",
    });

    expect(test.messages.map((message) => message.type)).toEqual([
      "portfolio.create.response",
      "portfolio.project.add.response",
      "portfolio.project.remove.response",
      "portfolio.archive.response",
    ]);
  });
});
