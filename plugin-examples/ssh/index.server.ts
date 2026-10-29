import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelTransfer,
  listRemoteFiles,
  listWorkspaceFiles,
  startDownload,
  startUpload,
  stopTransfers,
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
  targetWorkspaceSettings,
  transferStatusRpc,
} from "./shared/contracts";

const TEARDOWN_WAIT_MS = 15_000;

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostsSettings);
  server.registerSettings(targetWorkspaceSettings);
  server.handle(listConfigHostsRpc, listConfigHosts);
  server.handle(listRemoteFilesRpc, listRemoteFiles);
  server.handle(listWorkspaceFilesRpc, listWorkspaceFiles);
  server.handle(startDownloadRpc, startDownload);
  server.handle(startUploadRpc, startUpload);
  server.handle(transferStatusRpc, transferStatus);
  server.handle(cancelTransferRpc, cancelTransfer);
  // Paseo awaits async cleanup on reload, disable, removal, and shutdown. Cancel running transfers
  // first so their partial files are removed; the bound covers ssh's 10 s kill grace plus cleanup.
  return () => stopTransfers(TEARDOWN_WAIT_MS);
}
