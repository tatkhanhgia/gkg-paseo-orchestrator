import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PortfoliosScreen } from "@/portfolios/portfolios-screen";

export default function HostPortfoliosRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  return (
    <HostRouteBootstrapBoundary>
      <PortfoliosScreen serverId={serverId} selectedPortfolioId={null} />
    </HostRouteBootstrapBoundary>
  );
}
