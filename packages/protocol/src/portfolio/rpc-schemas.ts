import { z } from "zod";

export const PortfolioRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  projectIds: z.array(z.string().min(1)),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const PortfolioRequestFields = {
  requestId: z.string(),
} as const;

export const PortfolioListRequestSchema = z.object({
  type: z.literal("portfolio.list.request"),
  ...PortfolioRequestFields,
});

export const PortfolioGetRequestSchema = z.object({
  type: z.literal("portfolio.get.request"),
  ...PortfolioRequestFields,
  portfolioId: z.string().min(1),
});

export const PortfolioCreateRequestSchema = z.object({
  type: z.literal("portfolio.create.request"),
  ...PortfolioRequestFields,
  name: z.string(),
});

export const PortfolioProjectAddRequestSchema = z.object({
  type: z.literal("portfolio.project.add.request"),
  ...PortfolioRequestFields,
  portfolioId: z.string().min(1),
  projectId: z.string().min(1),
});

export const PortfolioProjectRemoveRequestSchema = z.object({
  type: z.literal("portfolio.project.remove.request"),
  ...PortfolioRequestFields,
  portfolioId: z.string().min(1),
  projectId: z.string().min(1),
});

export const PortfolioArchiveRequestSchema = z.object({
  type: z.literal("portfolio.archive.request"),
  ...PortfolioRequestFields,
  portfolioId: z.string().min(1),
});

export const PortfolioListResponseSchema = z.object({
  type: z.literal("portfolio.list.response"),
  payload: z.object({
    requestId: z.string(),
    portfolios: z.array(PortfolioRecordSchema),
  }),
});

export const PortfolioGetResponseSchema = z.object({
  type: z.literal("portfolio.get.response"),
  payload: z.object({
    requestId: z.string(),
    portfolio: PortfolioRecordSchema,
  }),
});

export const PortfolioCreateResponseSchema = z.object({
  type: z.literal("portfolio.create.response"),
  payload: z.object({
    requestId: z.string(),
    portfolio: PortfolioRecordSchema,
  }),
});

export const PortfolioProjectAddResponseSchema = z.object({
  type: z.literal("portfolio.project.add.response"),
  payload: z.object({
    requestId: z.string(),
    portfolio: PortfolioRecordSchema,
  }),
});

export const PortfolioProjectRemoveResponseSchema = z.object({
  type: z.literal("portfolio.project.remove.response"),
  payload: z.object({
    requestId: z.string(),
    portfolio: PortfolioRecordSchema,
  }),
});

export const PortfolioArchiveResponseSchema = z.object({
  type: z.literal("portfolio.archive.response"),
  payload: z.object({
    requestId: z.string(),
    portfolio: PortfolioRecordSchema,
  }),
});

export type PortfolioRecord = z.infer<typeof PortfolioRecordSchema>;
export type PortfolioListRequest = z.infer<typeof PortfolioListRequestSchema>;
export type PortfolioGetRequest = z.infer<typeof PortfolioGetRequestSchema>;
export type PortfolioCreateRequest = z.infer<typeof PortfolioCreateRequestSchema>;
export type PortfolioProjectAddRequest = z.infer<typeof PortfolioProjectAddRequestSchema>;
export type PortfolioProjectRemoveRequest = z.infer<typeof PortfolioProjectRemoveRequestSchema>;
export type PortfolioArchiveRequest = z.infer<typeof PortfolioArchiveRequestSchema>;
export type PortfolioListPayload = z.infer<typeof PortfolioListResponseSchema>["payload"];
export type PortfolioGetPayload = z.infer<typeof PortfolioGetResponseSchema>["payload"];
export type PortfolioCreatePayload = z.infer<typeof PortfolioCreateResponseSchema>["payload"];
export type PortfolioProjectAddPayload = z.infer<
  typeof PortfolioProjectAddResponseSchema
>["payload"];
export type PortfolioProjectRemovePayload = z.infer<
  typeof PortfolioProjectRemoveResponseSchema
>["payload"];
export type PortfolioArchivePayload = z.infer<typeof PortfolioArchiveResponseSchema>["payload"];
