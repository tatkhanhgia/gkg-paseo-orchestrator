import { describe, expect, it } from "vitest";

import {
  PortfolioArchiveRequestSchema,
  PortfolioArchiveResponseSchema,
  PortfolioCreateRequestSchema,
  PortfolioCreateResponseSchema,
  PortfolioGetRequestSchema,
  PortfolioGetResponseSchema,
  PortfolioListRequestSchema,
  PortfolioListResponseSchema,
  PortfolioProjectAddRequestSchema,
  PortfolioProjectAddResponseSchema,
  PortfolioProjectRemoveRequestSchema,
  PortfolioProjectRemoveResponseSchema,
  PortfolioRecordSchema,
} from "./portfolio/rpc-schemas.js";
import {
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("portfolio protocol schemas", () => {
  it("parses portfolio RPC request and response pairs", () => {
    const portfolio = PortfolioRecordSchema.parse({
      id: "pf_0123456789abcdef",
      name: "Core apps",
      projectIds: ["prj_0123456789abcdef"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      archivedAt: null,
    });

    expect(
      PortfolioListRequestSchema.parse({ type: "portfolio.list.request", requestId: "list-1" }),
    ).toEqual({
      type: "portfolio.list.request",
      requestId: "list-1",
    });
    expect(
      PortfolioListResponseSchema.parse({
        type: "portfolio.list.response",
        payload: { requestId: "list-1", portfolios: [portfolio] },
      }).payload.portfolios,
    ).toEqual([portfolio]);

    expect(
      PortfolioGetRequestSchema.parse({
        type: "portfolio.get.request",
        requestId: "get-1",
        portfolioId: portfolio.id,
      }).portfolioId,
    ).toBe(portfolio.id);
    expect(
      PortfolioGetResponseSchema.parse({
        type: "portfolio.get.response",
        payload: { requestId: "get-1", portfolio },
      }).payload.portfolio,
    ).toEqual(portfolio);

    expect(
      PortfolioCreateRequestSchema.parse({
        type: "portfolio.create.request",
        requestId: "create-1",
        name: "  New portfolio  ",
      }).name,
    ).toBe("  New portfolio  ");
    expect(
      PortfolioCreateResponseSchema.parse({
        type: "portfolio.create.response",
        payload: { requestId: "create-1", portfolio },
      }).payload.portfolio,
    ).toEqual(portfolio);

    expect(
      PortfolioProjectAddRequestSchema.parse({
        type: "portfolio.project.add.request",
        requestId: "add-1",
        portfolioId: portfolio.id,
        projectId: "prj_0123456789abcdef",
      }).projectId,
    ).toBe("prj_0123456789abcdef");
    expect(
      PortfolioProjectAddResponseSchema.parse({
        type: "portfolio.project.add.response",
        payload: { requestId: "add-1", portfolio },
      }).payload.portfolio,
    ).toEqual(portfolio);

    expect(
      PortfolioProjectRemoveRequestSchema.parse({
        type: "portfolio.project.remove.request",
        requestId: "remove-1",
        portfolioId: portfolio.id,
        projectId: "prj_0123456789abcdef",
      }).projectId,
    ).toBe("prj_0123456789abcdef");
    expect(
      PortfolioProjectRemoveResponseSchema.parse({
        type: "portfolio.project.remove.response",
        payload: { requestId: "remove-1", portfolio },
      }).payload.portfolio,
    ).toEqual(portfolio);

    expect(
      PortfolioArchiveRequestSchema.parse({
        type: "portfolio.archive.request",
        requestId: "archive-1",
        portfolioId: portfolio.id,
      }).portfolioId,
    ).toBe(portfolio.id);
    expect(
      PortfolioArchiveResponseSchema.parse({
        type: "portfolio.archive.response",
        payload: {
          requestId: "archive-1",
          portfolio: { ...portfolio, archivedAt: "2026-08-15T01:00:00.000Z" },
        },
      }).payload.portfolio.archivedAt,
    ).toBe("2026-08-15T01:00:00.000Z");
  });

  it("keeps the portfolios feature flag optional for older server_info payloads", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "server-old",
      features: {},
    });

    expect(parsed.features?.portfolios).toBeUndefined();
  });

  it("registers every Portfolio RPC in the session message unions", () => {
    const portfolio = {
      id: "pf_0123456789abcdef",
      name: "Core apps",
      projectIds: ["prj_0123456789abcdef"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      archivedAt: null,
    };
    const inbound = [
      { type: "portfolio.list.request", requestId: "list" },
      { type: "portfolio.get.request", requestId: "get", portfolioId: portfolio.id },
      { type: "portfolio.create.request", requestId: "create", name: "Core apps" },
      {
        type: "portfolio.project.add.request",
        requestId: "add",
        portfolioId: portfolio.id,
        projectId: "prj_0123456789abcdef",
      },
      {
        type: "portfolio.project.remove.request",
        requestId: "remove",
        portfolioId: portfolio.id,
        projectId: "prj_0123456789abcdef",
      },
      { type: "portfolio.archive.request", requestId: "archive", portfolioId: portfolio.id },
    ];
    const outbound = [
      { type: "portfolio.list.response", payload: { requestId: "list", portfolios: [portfolio] } },
      { type: "portfolio.get.response", payload: { requestId: "get", portfolio } },
      { type: "portfolio.create.response", payload: { requestId: "create", portfolio } },
      { type: "portfolio.project.add.response", payload: { requestId: "add", portfolio } },
      { type: "portfolio.project.remove.response", payload: { requestId: "remove", portfolio } },
      { type: "portfolio.archive.response", payload: { requestId: "archive", portfolio } },
    ];

    for (const message of inbound) {
      expect(SessionInboundMessageSchema.safeParse(message).success).toBe(true);
    }
    for (const message of outbound) {
      expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("parses the portfolios capability when present", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "server-new",
      features: { portfolios: true },
    });

    expect(parsed.features?.portfolios).toBe(true);
  });
});
