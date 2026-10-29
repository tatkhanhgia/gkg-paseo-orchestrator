import { describe, expect, it } from "vitest";
import { resolveWorkspaceId, toWorkspaceOptions, type WorkspaceOption } from "./workspaces";

function option(id: string): WorkspaceOption {
  return { id, label: id, directory: `/work/${id}` };
}

describe("toWorkspaceOptions", () => {
  it("qualifies a workspace with its project, sorts by label, and hides archiving ones", () => {
    const options = toWorkspaceOptions([
      { id: "w3", name: "main", projectDisplayName: "paseo", workspaceDirectory: "/src/paseo" },
      { id: "w2", name: "hotfix", projectDisplayName: "api" },
      { id: "w4", name: "gone", projectDisplayName: "api", archivingAt: "2026-10-29T00:00:00Z" },
      { id: "w1", name: "notes", projectDisplayName: "notes" },
    ]);
    expect(options).toEqual([
      { id: "w2", label: "api / hotfix", directory: "" },
      { id: "w1", label: "notes", directory: "" },
      { id: "w3", label: "paseo / main", directory: "/src/paseo" },
    ]);
  });

  it("falls back to the id for a workspace with a blank name", () => {
    expect(
      toWorkspaceOptions([{ id: "w9", name: "  ", projectDisplayName: "" }]).map((o) => o.label),
    ).toEqual(["w9"]);
  });
});

describe("resolveWorkspaceId", () => {
  const both = [option("a"), option("b")];

  it("keeps a remembered workspace that still exists", () => {
    expect(resolveWorkspaceId("b", both)).toBe("b");
  });

  it("asks the user to choose when the remembered workspace no longer exists", () => {
    expect(resolveWorkspaceId("removed", both)).toBeNull();
  });

  it("asks the user to choose when nothing was remembered and there is a choice", () => {
    expect(resolveWorkspaceId(undefined, both)).toBeNull();
  });

  it("uses the only workspace when nothing usable was remembered", () => {
    expect(resolveWorkspaceId(undefined, [option("only")])).toBe("only");
    expect(resolveWorkspaceId("removed", [option("only")])).toBe("only");
  });

  it("has no workspace when none exist", () => {
    expect(resolveWorkspaceId("a", [])).toBeNull();
  });
});
