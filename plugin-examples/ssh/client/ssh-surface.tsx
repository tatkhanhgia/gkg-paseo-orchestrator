import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SshScreen } from "./ssh-screen";

/** The sidebar screen. It needs no workspace: sessions and files never touch one. */
export function SshSurface({ theme, layout }: PluginSurfaceProps) {
  return <SshScreen theme={theme} layout={layout} />;
}
