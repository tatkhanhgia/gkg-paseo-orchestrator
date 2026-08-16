import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";

import { PortfolioServiceError, type PortfolioService } from "../../portfolio/portfolio-service.js";

export interface PortfolioSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface PortfolioSessionOptions {
  host: PortfolioSessionHost;
  service: PortfolioService;
}

export class PortfolioSession {
  constructor(private readonly options: PortfolioSessionOptions) {}

  async handleList(
    message: Extract<SessionInboundMessage, { type: "portfolio.list.request" }>,
  ): Promise<void> {
    await this.run(message, async () => {
      const portfolios = await this.options.service.list();
      this.options.host.emit({
        type: "portfolio.list.response",
        payload: {
          requestId: message.requestId,
          portfolios,
        },
      });
    });
  }

  async handleGet(
    message: Extract<SessionInboundMessage, { type: "portfolio.get.request" }>,
  ): Promise<void> {
    await this.run(message, async () => {
      const portfolio = await this.options.service.get(message.portfolioId);
      this.options.host.emit({
        type: "portfolio.get.response",
        payload: {
          requestId: message.requestId,
          portfolio,
        },
      });
    });
  }

  async handleCreate(
    message: Extract<SessionInboundMessage, { type: "portfolio.create.request" }>,
  ): Promise<void> {
    await this.run(message, async () => {
      const portfolio = await this.options.service.create(message.name);
      this.options.host.emit({
        type: "portfolio.create.response",
        payload: {
          requestId: message.requestId,
          portfolio,
        },
      });
    });
  }

  async handleProjectAdd(
    message: Extract<SessionInboundMessage, { type: "portfolio.project.add.request" }>,
  ): Promise<void> {
    await this.run(message, async () => {
      const portfolio = await this.options.service.addProject(
        message.portfolioId,
        message.projectId,
      );
      this.options.host.emit({
        type: "portfolio.project.add.response",
        payload: {
          requestId: message.requestId,
          portfolio,
        },
      });
    });
  }

  async handleProjectRemove(
    message: Extract<SessionInboundMessage, { type: "portfolio.project.remove.request" }>,
  ): Promise<void> {
    await this.run(message, async () => {
      const portfolio = await this.options.service.removeProject(
        message.portfolioId,
        message.projectId,
      );
      this.options.host.emit({
        type: "portfolio.project.remove.response",
        payload: {
          requestId: message.requestId,
          portfolio,
        },
      });
    });
  }

  async handleArchive(
    message: Extract<SessionInboundMessage, { type: "portfolio.archive.request" }>,
  ): Promise<void> {
    await this.run(message, async () => {
      const portfolio = await this.options.service.archive(message.portfolioId);
      this.options.host.emit({
        type: "portfolio.archive.response",
        payload: {
          requestId: message.requestId,
          portfolio,
        },
      });
    });
  }

  private async run(
    message: Extract<SessionInboundMessage, { type: string; requestId: string }>,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      const portfolioError =
        error instanceof PortfolioServiceError
          ? error
          : new PortfolioServiceError(
              "portfolio_request_failed",
              error instanceof Error ? error.message : "Portfolio request failed",
            );
      this.options.host.emit({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          error: portfolioError.message,
          code: portfolioError.code,
        },
      });
    }
  }
}
