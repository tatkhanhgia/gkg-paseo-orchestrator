import { describe, expect, it } from "vitest";
import { resolveSelection, sessionName } from "./sessions";

const sessions = [{ id: "a" }, { id: "b" }];

describe("resolveSelection", () => {
  it("follows the newest session, and falls back when a chosen one has ended", () => {
    expect(resolveSelection({ kind: "auto" }, sessions)).toEqual({ kind: "session", id: "b" });
    expect(resolveSelection({ kind: "auto" }, [])).toEqual({ kind: "files" });
    expect(resolveSelection({ kind: "session", id: "a" }, sessions)).toEqual({
      kind: "session",
      id: "a",
    });
    expect(resolveSelection({ kind: "session", id: "gone" }, sessions)).toEqual({
      kind: "session",
      id: "b",
    });
    expect(resolveSelection({ kind: "session", id: "gone" }, [])).toEqual({ kind: "files" });
    expect(resolveSelection({ kind: "files" }, sessions)).toEqual({ kind: "files" });
  });
});

describe("sessionName", () => {
  it("names the terminal after the host and strips control characters from the label", () => {
    expect(sessionName("prod")).toBe("ssh prod");
    expect(sessionName("a\u001b[31mb\nc")).toBe("ssh a [31mb c");
  });
});
