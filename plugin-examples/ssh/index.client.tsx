import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HostsPanel } from "./client/hosts-panel";
import { runSshSlashCommand } from "./client/slash-command";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "hosts",
    title: "SSH hosts",
    icon: "Terminal",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: HostsPanel,
  });
  client.addCommandCenterItem({
    id: "open-hosts",
    title: "SSH: Open hosts",
    icon: "Terminal",
    keywords: ["ssh", "connect", "remote", "host", "session"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("hosts");
    },
  });
  client.addSlashCommand({
    name: "ssh",
    description: "Open an SSH session in a workspace terminal",
    argumentHint: "<host>",
    context: "workspace",
    onSubmit: runSshSlashCommand,
  });
  return () => {};
}
