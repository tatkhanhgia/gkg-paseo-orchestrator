import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelTransfer,
  listRemoteFiles,
  listWorkspaceFiles,
  startDownload,
  startUpload,
  transferStatus,
} from "./server/files";
import { listConfigHosts } from "./server/hosts";
import {
  cancelTransferRpc,
  hostsSettings,
  listConfigHostsRpc,
  listRemoteFilesRpc,
  listWorkspaceFilesRpc,
  startDownloadRpc,
  startUploadRpc,
  transferStatusRpc,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostsSettings);
  server.handle(listConfigHostsRpc, listConfigHosts);
  server.handle(listRemoteFilesRpc, listRemoteFiles);
  server.handle(listWorkspaceFilesRpc, listWorkspaceFiles);
  server.handle(startDownloadRpc, startDownload);
  server.handle(startUploadRpc, startUpload);
  server.handle(transferStatusRpc, transferStatus);
  server.handle(cancelTransferRpc, cancelTransfer);
  return () => {};
}
