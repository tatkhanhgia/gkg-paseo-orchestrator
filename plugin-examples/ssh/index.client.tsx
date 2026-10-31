import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HostsPanel } from "./client/hosts-panel";
import { runSshSlashCommand } from "./client/slash-command";
import { SshSurface } from "./client/ssh-surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("ssh", SshSurface);
  client.addSidebarItem({ id: "ssh", title: "SSH", icon: "Terminal", surface: "ssh" });
  client.addCommandCenterItem({
    id: "open-ssh",
    title: "SSH",
    icon: "Terminal",
    keywords: ["ssh", "connect", "remote", "host", "session", "files", "sftp"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("ssh");
    },
  });
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
