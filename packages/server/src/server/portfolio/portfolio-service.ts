import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";

import type { ProjectRegistry } from "../workspace-registry.js";
import { generatePortfolioId, type PortfolioStore } from "./portfolio-store.js";

export class PortfolioServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PortfolioServiceError";
    this.code = code;
  }
}

export interface PortfolioService {
  list(): Promise<PortfolioRecord[]>;
  get(portfolioId: string): Promise<PortfolioRecord>;
  create(name: string): Promise<PortfolioRecord>;
  addProject(portfolioId: string, projectId: string): Promise<PortfolioRecord>;
  removeProject(portfolioId: string, projectId: string): Promise<PortfolioRecord>;
  removeProjectFromAll(projectId: string): Promise<void>;
  archive(portfolioId: string): Promise<PortfolioRecord>;
}

function normalizePortfolioName(name: string): string {
  return name.trim();
}

function normalizePortfolioNameKey(name: string): string {
  return normalizePortfolioName(name).toLowerCase();
}

function assertActivePortfolio(record: PortfolioRecord): void {
  if (record.archivedAt) {
    throw new PortfolioServiceError("portfolio_archived", `Portfolio ${record.id} is archived`);
  }
}

function findActivePortfolioOwningProject(
  portfolios: PortfolioRecord[],
  projectId: string,
): PortfolioRecord | null {
  for (const portfolio of portfolios) {
    if (portfolio.archivedAt) continue;
    if (portfolio.projectIds.includes(projectId)) {
      return portfolio;
    }
  }
  return null;
}

export class FileBackedPortfolioService implements PortfolioService {
  constructor(
    private readonly store: PortfolioStore,
    private readonly projectRegistry: Pick<ProjectRegistry, "get">,
  ) {}

  async list(): Promise<PortfolioRecord[]> {
    return this.store.listActive();
  }

  async get(portfolioId: string): Promise<PortfolioRecord> {
    const portfolio = await this.store.get(portfolioId);
    if (!portfolio) {
      throw new PortfolioServiceError(
        "portfolio_not_found",
        `Portfolio ${portfolioId} was not found`,
      );
    }
    return portfolio;
  }

  async create(name: string): Promise<PortfolioRecord> {
    const normalizedName = normalizePortfolioName(name);
    if (!normalizedName) {
      throw new PortfolioServiceError("portfolio_name_invalid", "Portfolio name must not be empty");
    }

    return this.store.runMutation(async (mutation) => {
      const nameKey = normalizePortfolioNameKey(normalizedName);
      for (const portfolio of mutation.listActive()) {
        if (normalizePortfolioNameKey(portfolio.name) === nameKey) {
          throw new PortfolioServiceError(
            "portfolio_name_taken",
            `Portfolio name '${normalizedName}' is already in use`,
          );
        }
      }

      const timestamp = new Date().toISOString();
      const record: PortfolioRecord = {
        id: generatePortfolioId(),
        name: normalizedName,
        projectIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      };
      await mutation.insert(record);
      return record;
    });
  }

  async addProject(portfolioId: string, projectId: string): Promise<PortfolioRecord> {
    await this.requireActiveProject(projectId);

    return this.store.runMutation(async (mutation) => {
      const portfolio = mutation.get(portfolioId);
      if (!portfolio) {
        throw new PortfolioServiceError(
          "portfolio_not_found",
          `Portfolio ${portfolioId} was not found`,
        );
      }
      assertActivePortfolio(portfolio);

      if (portfolio.projectIds.includes(projectId)) {
        return portfolio;
      }

      const owner = findActivePortfolioOwningProject(mutation.listActive(), projectId);
      if (owner && owner.id !== portfolioId) {
        throw new PortfolioServiceError(
          "project_in_other_portfolio",
          `Project ${projectId} already belongs to portfolio ${owner.id}`,
        );
      }

      const updatedAt = new Date().toISOString();
      const next = await mutation.update(portfolioId, (record) => ({
        ...record,
        projectIds: [...record.projectIds, projectId],
        updatedAt,
      }));
      if (!next) {
        throw new PortfolioServiceError(
          "portfolio_not_found",
          `Portfolio ${portfolioId} was not found`,
        );
      }
      return next;
    });
  }

  async removeProject(portfolioId: string, projectId: string): Promise<PortfolioRecord> {
    return this.store.runMutation(async (mutation) => {
      const portfolio = mutation.get(portfolioId);
      if (!portfolio) {
        throw new PortfolioServiceError(
          "portfolio_not_found",
          `Portfolio ${portfolioId} was not found`,
        );
      }
      assertActivePortfolio(portfolio);
      if (!portfolio.projectIds.includes(projectId)) {
        return portfolio;
      }

      const updatedAt = new Date().toISOString();
      const next = await mutation.update(portfolioId, (record) => ({
        ...record,
        projectIds: record.projectIds.filter((memberId) => memberId !== projectId),
        updatedAt,
      }));
      if (!next) {
        throw new PortfolioServiceError(
          "portfolio_not_found",
          `Portfolio ${portfolioId} was not found`,
        );
      }
      return next;
    });
  }

  async removeProjectFromAll(projectId: string): Promise<void> {
    await this.store.runMutation(async (mutation) => {
      const updatedAt = new Date().toISOString();
      for (const portfolio of mutation.listAll()) {
        if (!portfolio.projectIds.includes(projectId)) {
          continue;
        }
        await mutation.update(portfolio.id, (record) => ({
          ...record,
          projectIds: record.projectIds.filter((memberId) => memberId !== projectId),
          updatedAt,
        }));
      }
    });
  }

  async archive(portfolioId: string): Promise<PortfolioRecord> {
    return this.store.runMutation(async (mutation) => {
      const portfolio = mutation.get(portfolioId);
      if (!portfolio) {
        throw new PortfolioServiceError(
          "portfolio_not_found",
          `Portfolio ${portfolioId} was not found`,
        );
      }
      if (portfolio.archivedAt) {
        return portfolio;
      }

      const archivedAt = new Date().toISOString();
      const next = await mutation.update(portfolioId, (record) => ({
        ...record,
        archivedAt,
        updatedAt: archivedAt,
      }));
      if (!next) {
        throw new PortfolioServiceError(
          "portfolio_not_found",
          `Portfolio ${portfolioId} was not found`,
        );
      }
      return next;
    });
  }

  private async requireActiveProject(projectId: string): Promise<void> {
    const project = await this.projectRegistry.get(projectId);
    if (!project || project.archivedAt) {
      throw new PortfolioServiceError(
        "project_not_found",
        `Project ${projectId} is unavailable or archived`,
      );
    }
  }
}
