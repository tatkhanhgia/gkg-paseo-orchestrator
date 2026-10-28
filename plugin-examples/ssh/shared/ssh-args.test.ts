import { describe, expect, it } from "vitest";
import { buildSshInvocation } from "./ssh-args";

describe("buildSshInvocation", () => {
  it.each([
    ["a config alias", { host: "prod" }, ["--", "prod"]],
    [
      "a fully specified user host",
      { host: "10.0.0.5", user: "deploy", port: 2222, identityFile: "/home/me/.ssh/id_ed25519" },
      ["-p", "2222", "-i", "/home/me/.ssh/id_ed25519", "-l", "deploy", "--", "10.0.0.5"],
    ],
    [
      "an identity file path containing a space as one element",
      { host: "h", identityFile: "/Users/Jane Doe/.ssh/key" },
      ["-i", "/Users/Jane Doe/.ssh/key", "--", "h"],
    ],
  ])("builds argv for %s", (_name, target, args) => {
    expect(buildSshInvocation(target)).toEqual({ command: "ssh", args });
  });

  it.each([
    ["host that ssh would read as an option", { host: "-oProxyCommand=touch /tmp/pwned" }],
    ["host that is a bare dash option", { host: "-v" }],
    ["host containing a space", { host: "evil host" }],
    ["host containing a newline", { host: "evil\nhost" }],
    ["host containing a NUL byte", { host: "evil\u0000host" }],
    ["empty host", { host: "" }],
    ["user that ssh would read as an option", { host: "h", user: "-oProxyCommand=x" }],
    ["user containing a tab", { host: "h", user: "a\tb" }],
    ["identity file starting with a dash", { host: "h", identityFile: "-F/tmp/evil" }],
    ["identity file containing a control character", { host: "h", identityFile: "/k\u001b[0m" }],
    ["port zero", { host: "h", port: 0 }],
    ["port above 65535", { host: "h", port: 65536 }],
    ["fractional port", { host: "h", port: 22.5 }],
  ])("rejects %s", (_name, target) => {
    expect(() => buildSshInvocation(target)).toThrow(/Invalid SSH/);
  });
});
