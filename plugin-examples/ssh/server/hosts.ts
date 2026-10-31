import { loadSshConfigHosts } from "./ssh-config";

export async function listConfigHosts() {
  return loadSshConfigHosts();
}
