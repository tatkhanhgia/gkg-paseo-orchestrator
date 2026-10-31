import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelTransfer,
  listRemoteFiles,
  releaseDownload,
  startDownload,
  startUpload,
  stopTransfers,
  sweepStaleStaging,
  transferStatus,
} from "./server/files";
import { listConfigHosts } from "./server/hosts";
import { startSession } from "./server/sessions";
import {
  cancelTransferRpc,
  hostsSettings,
  listConfigHostsRpc,
  listRemoteFilesRpc,
  releaseDownloadRpc,
  startDownloadRpc,
  startSessionRpc,
  startUploadRpc,
  transferStatusRpc,
} from "./shared/contracts";

const TEARDOWN_WAIT_MS = 15_000;

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostsSettings);
  server.handle(listConfigHostsRpc, listConfigHosts);
  server.handle(startSessionRpc, startSession);
  server.handle(listRemoteFilesRpc, listRemoteFiles);
  server.handle(startDownloadRpc, startDownload);
  server.handle(startUploadRpc, (input) => startUpload(input, server.resolveDeviceUpload));
  server.handle(transferStatusRpc, transferStatus);
  server.handle(cancelTransferRpc, cancelTransfer);
  server.handle(releaseDownloadRpc, releaseDownload);
  // Downloads staged by a plugin process that crashed are removed when the plugin starts again.
  void sweepStaleStaging();
  // Paseo awaits async cleanup on reload, disable, removal, and shutdown. Cancel running transfers
  // first so their partial files are removed; the bound covers ssh's 10 s kill grace plus cleanup.
  // Paseo ends the plugin's ssh sessions itself when the plugin stops.
  return () => stopTransfers(TEARDOWN_WAIT_MS);
}
