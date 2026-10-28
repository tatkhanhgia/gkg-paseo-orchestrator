import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSshConfigHosts, parseSshConfig } from "./ssh-config";

describe("parseSshConfig", () => {
  it("lists concrete aliases with their display options and skips patterns", () => {
    const parsed = parseSshConfig(`
# comment
Host *
  User ignored
  ForwardAgent yes

Host prod staging
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_prod

Host dev-?? !blocked *.internal
  HostName never

host=lower
  hostname = lower.example.com
`);
    expect(parsed.hosts).toEqual([
      {
        alias: "prod",
        hostName: "10.0.0.5",
        user: "deploy",
        port: 2222,
        identityFile: "~/.ssh/id_prod",
      },
      {
        alias: "staging",
        hostName: "10.0.0.5",
        user: "deploy",
        port: 2222,
        identityFile: "~/.ssh/id_prod",
      },
      { alias: "lower", hostName: "lower.example.com" },
    ]);
  });

  it("keeps the first value of an option and ends a block at Match", () => {
    const parsed = parseSshConfig(`
Host a
  User first
  User second
Match host b
  User matched
Host c # trailing comment
  Port notanumber
`);
    expect(parsed.hosts).toEqual([{ alias: "a", user: "first" }, { alias: "c" }]);
  });

  it("drops aliases ssh would parse as options and keeps quoted values whole", () => {
    const parsed = parseSshConfig(`
Host -oProxyCommand=evil ok
  IdentityFile "/Users/Jane Doe/key"
`);
    expect(parsed.hosts).toEqual([{ alias: "ok", identityFile: "/Users/Jane Doe/key" }]);
  });

  it("returns Include paths unresolved", () => {
    expect(parseSshConfig("Include conf.d/*.conf ~/extra\nHost a\n").includes).toEqual([
      "conf.d/*.conf",
      "~/extra",
    ]);
  });
});

describe("loadSshConfigHosts", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ssh-plugin-"));
    await mkdir(path.join(home, ".ssh", "conf.d"), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns no hosts and no error when the config file is absent", async () => {
    expect(await loadSshConfigHosts({ homeDir: home })).toEqual({
      hosts: [],
      configPath: path.join(home, ".ssh", "config"),
    });
  });

  it("follows relative globbed Includes, survives a cycle, and lists a file before its includes and keeps the first duplicate", async () => {
    const ssh = path.join(home, ".ssh");
    await writeFile(
      path.join(ssh, "config"),
      "Include conf.d/*.conf\nInclude config\nHost main\n  HostName main.example.com\nHost dup\n  User top\n",
    );
    await writeFile(path.join(ssh, "conf.d", "b.conf"), "Host from-b\n");
    await writeFile(path.join(ssh, "conf.d", "a.conf"), "Host from-a\nHost dup\n  User included\n");
    await writeFile(path.join(ssh, "conf.d", "skip.txt"), "Host not-included\n");

    const { hosts } = await loadSshConfigHosts({ homeDir: home });

    expect(hosts).toEqual([
      { alias: "main", hostName: "main.example.com" },
      { alias: "dup", user: "top" },
      { alias: "from-a" },
      { alias: "from-b" },
    ]);
  });
});
