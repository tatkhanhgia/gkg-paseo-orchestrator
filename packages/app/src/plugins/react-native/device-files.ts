import type { DeviceFiles, DeviceUpload, HostFile } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import { useFilePicker } from "@/hooks/use-file-picker";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore, useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { usePluginServerId } from "../installation-provider";

/**
 * Device file transfer for plugins, on the same paths the file explorer and composer use: `save`
 * goes through the download store (HTTP token download on a direct connection, the session socket
 * otherwise), and `pick` through the file picker and `uploadFile`, which lands under
 * `$PASEO_HOME/uploads`. Neither needs a workspace.
 */
export function useDeviceFiles(): DeviceFiles {
  const serverId = usePluginServerId();
  const client = useHostRuntimeClient(serverId);
  const hosts = useHosts();
  const { pickFiles } = useFilePicker();

  return useMemo(() => {
    function requireClient() {
      if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      return client;
    }

    async function save({ directory, path }: HostFile): Promise<void> {
      const connected = requireClient();
      const id = await useDownloadStore.getState().startDownload({
        serverId,
        scopeId: directory,
        fileName: path.split("/").pop() || path,
        path,
        daemonProfile: hosts.find((host) => host.serverId === serverId),
        activeConnectionId: getHostRuntimeStore().getSnapshot(serverId)?.activeConnectionId ?? null,
        requestFileDownloadToken: async (target) => {
          const payload = await connected.requestDownloadToken(directory, target);
          if (payload.error) throw new Error(payload.error);
          return payload;
        },
        // No request timeout, as in the file explorer: a large file over a relay takes a while.
        readFile: (target, maxBytes) =>
          connected.readFile(directory, target, undefined, maxBytes, 0),
      });
      const download = useDownloadStore.getState().downloads.get(id);
      if (download?.status === "error") {
        throw new Error(download.message ?? i18n.t("downloads.failed"));
      }
    }

    async function pick(): Promise<DeviceUpload | null> {
      const connected = requireClient();
      const file = (await pickFiles({ multiple: false }))?.[0];
      if (!file) return null;
      const bytes = await file.readBytes();
      if (bytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
        throw new Error(
          i18n.t("composer.errors.fileTooLarge", { size: "50MB", fileName: file.fileName }),
        );
      }
      const response = await connected.uploadFile({
        fileName: file.fileName,
        mimeType: file.mimeType,
        bytes,
      });
      if (response.error || !response.file) throw new Error(response.error ?? "Upload failed.");
      return { id: response.file.id, fileName: response.file.fileName, size: response.file.size };
    }

    return { save, pick };
  }, [client, hosts, pickFiles, serverId]);
}
