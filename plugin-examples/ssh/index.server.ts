import type { PluginServerContext } from "@getpaseo/plugin/server";
import { downloadFile, listRemoteFiles, listWorkspaceFiles, uploadFile } from "./server/files";
import { listConfigHosts } from "./server/hosts";
import {
  downloadFileRpc,
  hostsSettings,
  listConfigHostsRpc,
  listRemoteFilesRpc,
  listWorkspaceFilesRpc,
  uploadFileRpc,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostsSettings);
  server.handle(listConfigHostsRpc, listConfigHosts);
  server.handle(listRemoteFilesRpc, listRemoteFiles);
  server.handle(listWorkspaceFilesRpc, listWorkspaceFiles);
  server.handle(downloadFileRpc, downloadFile);
  server.handle(uploadFileRpc, uploadFile);
  return () => {};
}
