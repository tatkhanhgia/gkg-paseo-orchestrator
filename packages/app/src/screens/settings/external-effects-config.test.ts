import { describe, expect, it } from "vitest";

import {
  addCatalogEntry,
  catalogValidationError,
  createCatalogEntryId,
  normalizeCatalogForSave,
  removeCatalogEntry,
  updateCatalogEntry,
} from "./external-effects-config";

const SAVED = [{ id: "postgres-prddev", label: "Postgres prddev", grant: "read/write prddev" }];

describe("createCatalogEntryId", () => {
  it("slugs the label", () => {
    expect(createCatalogEntryId("Postgres prddev (write)", [])).toBe("postgres-prddev-write");
  });

  it("falls back when the label has no usable characters", () => {
    expect(createCatalogEntryId("!!!", [])).toBe("grant");
  });

  it("suffixes around a taken id", () => {
    expect(createCatalogEntryId("Build box", ["build-box", "build-box-2"])).toBe("build-box-3");
  });
});

describe("catalog editing", () => {
  it("adds, updates, and removes rows", () => {
    const added = addCatalogEntry(SAVED);
    expect(added).toHaveLength(2);
    const rowId = added[1]?.id as string;
    const edited = updateCatalogEntry(added, rowId, { label: "Build box" });
    expect(edited[1]?.label).toBe("Build box");
    expect(removeCatalogEntry(edited, rowId)).toEqual(SAVED);
  });
});

describe("normalizeCatalogForSave", () => {
  it("drops blank rows and trims the rest", () => {
    const draft = [
      { id: "a", label: "  Postgres  ", grant: "  read/write  " },
      { id: "draft:1", label: "", grant: "" },
    ];
    expect(normalizeCatalogForSave(draft)).toEqual([
      { id: "a", label: "Postgres", grant: "read/write" },
    ]);
  });

  it("gives new rows an id derived from their label, keeping saved ids stable", () => {
    const draft = [
      ...SAVED,
      { id: "draft:1", label: "Build box SSH", grant: "ssh build-01" },
      { id: "draft:2", label: "Build box SSH", grant: "ssh build-02" },
    ];
    expect(normalizeCatalogForSave(draft).map((entry) => entry.id)).toEqual([
      "postgres-prddev",
      "build-box-ssh",
      "build-box-ssh-2",
    ]);
  });
});

describe("catalogValidationError", () => {
  it("accepts a clean draft and an empty one", () => {
    expect(catalogValidationError(SAVED)).toBeNull();
    expect(catalogValidationError([])).toBeNull();
  });

  it("ignores a row that is still entirely blank", () => {
    expect(catalogValidationError(addCatalogEntry(SAVED))).toBeNull();
  });

  it("rejects a half-filled row", () => {
    const draft = [{ id: "draft:1", label: "Postgres", grant: "" }];
    expect(catalogValidationError(draft)).toMatch(/both a name and the access text/u);
  });

  it("rejects duplicate access text", () => {
    const draft = [
      { id: "a", label: "One", grant: "same" },
      { id: "b", label: "Two", grant: "same" },
    ];
    expect(catalogValidationError(draft)).toMatch(/same access text/u);
  });

  it("rejects overlong access text", () => {
    const draft = [{ id: "a", label: "One", grant: "x".repeat(501) }];
    expect(catalogValidationError(draft)).toMatch(/under 500 characters/u);
  });
});
