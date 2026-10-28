import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listConfigHosts } from "./server/hosts";
import { hostsSettings, listConfigHostsRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostsSettings);
  server.handle(listConfigHostsRpc, listConfigHosts);
  return () => {};
}
