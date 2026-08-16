import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PortfoliosScreen } from "@/portfolios/portfolios-screen";

export default function HostPortfolioDetailRoute() {
  const params = useLocalSearchParams<{ serverId?: string; portfolioId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const portfolioId = typeof params.portfolioId === "string" ? params.portfolioId : "";
  return (
    <HostRouteBootstrapBoundary>
      <PortfoliosScreen serverId={serverId} selectedPortfolioId={portfolioId} />
    </HostRouteBootstrapBoundary>
  );
}
