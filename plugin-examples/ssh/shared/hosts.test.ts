import { describe, expect, it } from "vitest";
import { findHostEntries, parseNewUserHost, toHostEntries } from "./hosts";

const blank = { label: "", host: "", user: "", port: "", identityFile: "" };

describe("parseNewUserHost", () => {
  it("trims fields and drops empty optional ones", () => {
    expect(
      parseNewUserHost({ ...blank, label: " Build ", host: " 10.1.1.1 ", port: " 2200 " }),
    ).toEqual({ ok: true, host: { label: "Build", host: "10.1.1.1", port: 2200 } });
  });

  it.each([
    ["missing label", { host: "h" }, "Enter a label"],
    ["option-like host", { label: "x", host: "-oProxyCommand=x" }, "Host must not start with '-'"],
    ["host with a space", { label: "x", host: "a b" }, "Host must not contain whitespace"],
    ["option-like user", { label: "x", host: "h", user: "-l" }, "User must not start with '-'"],
    ["non-numeric port", { label: "x", host: "h", port: "22abc" }, "Port must be a number"],
    ["port zero", { label: "x", host: "h", port: "0" }, "Port must be a number"],
  ])("rejects %s", (_name, fields, message) => {
    const result = parseNewUserHost({ ...blank, ...fields });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(message);
  });
});

describe("host entries", () => {
  const entries = toHostEntries(
    [{ alias: "Prod", hostName: "prod.example.com", user: "root", port: 22 }],
    [{ id: "1", label: "prod", host: "10.0.0.9", user: "deploy" }],
  );

  it("connects config hosts by alias and user hosts by their own fields", () => {
    expect(entries.map(({ source, target }) => ({ source, target }))).toEqual([
      { source: "user", target: { host: "10.0.0.9", user: "deploy" } },
      { source: "config", target: { host: "Prod" } },
    ]);
  });

  it("matches user labels ignoring case but config aliases exactly", () => {
    expect(findHostEntries("PROD", entries).map((entry) => entry.key)).toEqual(["user:1"]);
    expect(findHostEntries("Prod", entries).map((entry) => entry.key)).toEqual([
      "user:1",
      "config:Prod",
    ]);
    expect(findHostEntries("staging", entries)).toEqual([]);
  });
});
