import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import {
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
} from "@/runtime/host-runtime";

export const portfolioQueryKeys = {
  all: (serverId: string) => ["portfolios", serverId] as const,
};

export function usePortfoliosQuery(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsPortfolios = useHostFeature(serverId, "portfolios");
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);

  const query = useFetchQuery({
    queryKey: [...portfolioQueryKeys.all(serverId), runtimeSnapshot?.clientGeneration ?? 0],
    queryFn: async () => {
      if (!client) throw new Error("Host client unavailable");
      const response = await client.listPortfolios();
      return response.portfolios;
    },
    enabled: Boolean(serverId && client && isConnected && supportsPortfolios),
    retry: false,
    dataShape: "list",
    staleTimeMs: 2_000,
  });

  return { ...query, client, isConnected, supportsPortfolios };
}

export function usePortfolioMutations(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: portfolioQueryKeys.all(serverId) }),
    [queryClient, serverId],
  );

  const createMutation = useMutation({
    mutationFn: async (name: string): Promise<PortfolioRecord> => {
      if (!client) throw new Error("Host client unavailable");
      return (await client.createPortfolio({ name })).portfolio;
    },
    onSuccess: invalidate,
  });
  const addProjectMutation = useMutation({
    mutationFn: async (input: {
      portfolioId: string;
      projectId: string;
    }): Promise<PortfolioRecord> => {
      if (!client) throw new Error("Host client unavailable");
      return (await client.addPortfolioProject(input)).portfolio;
    },
    onSuccess: invalidate,
  });
  const removeProjectMutation = useMutation({
    mutationFn: async (input: {
      portfolioId: string;
      projectId: string;
    }): Promise<PortfolioRecord> => {
      if (!client) throw new Error("Host client unavailable");
      return (await client.removePortfolioProject(input)).portfolio;
    },
    onSuccess: invalidate,
  });
  const archiveMutation = useMutation({
    mutationFn: async (portfolioId: string): Promise<PortfolioRecord> => {
      if (!client) throw new Error("Host client unavailable");
      return (await client.archivePortfolio({ portfolioId })).portfolio;
    },
    onSuccess: invalidate,
  });

  return {
    create: createMutation.mutateAsync,
    addProject: addProjectMutation.mutateAsync,
    removeProject: removeProjectMutation.mutateAsync,
    archive: archiveMutation.mutateAsync,
    createMutation,
    addProjectMutation,
    removeProjectMutation,
    archiveMutation,
  };
}
