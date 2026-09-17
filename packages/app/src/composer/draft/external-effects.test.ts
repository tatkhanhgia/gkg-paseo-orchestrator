import { describe, expect, it } from "vitest";

import {
  buildExternalEffectOptions,
  parseExternalEffects,
  summarizeExternalEffects,
  toggleExternalEffectGrant,
} from "./external-effects";

const CATALOG = [
  { id: "db.prddev.write", label: "Postgres prddev", grant: "read/write dev Postgres" },
  { id: "net.ssh.build", label: "Build box SSH", grant: "ssh build-01" },
];

describe("parseExternalEffects", () => {
  it("trims, drops blanks, and dedupes", () => {
    expect(parseExternalEffects("  a  \n\n a \nb\n")).toEqual(["a", "b"]);
  });
});

describe("summarizeExternalEffects", () => {
  it("names a lone grant and counts the rest", () => {
    expect(summarizeExternalEffects([])).toBe("No external access");
    expect(summarizeExternalEffects(["read/write dev Postgres"])).toBe("read/write dev Postgres");
    expect(summarizeExternalEffects(["a", "b"])).toBe("2 external grants");
  });
});

describe("toggleExternalEffectGrant", () => {
  it("appends a grant that is absent", () => {
    expect(toggleExternalEffectGrant("", "ssh build-01")).toBe("ssh build-01");
    expect(toggleExternalEffectGrant("a", "ssh build-01")).toBe("a\nssh build-01");
  });

  it("removes a grant that is present and keeps the rest in order", () => {
    expect(toggleExternalEffectGrant("a\nssh build-01\nb", "ssh build-01")).toBe("a\nb");
  });

  it("keeps free-typed lines when a catalog entry is toggled", () => {
    const typed = "hand written grant";
    const withCatalog = toggleExternalEffectGrant(typed, "ssh build-01");
    expect(toggleExternalEffectGrant(withCatalog, "ssh build-01")).toBe(typed);
  });
});

describe("buildExternalEffectOptions", () => {
  it("marks entries whose grant is already in the value", () => {
    const options = buildExternalEffectOptions(CATALOG, "read/write dev Postgres");
    expect(options.map((option) => [option.id, option.selected])).toEqual([
      ["db.prddev.write", true],
      ["net.ssh.build", false],
    ]);
  });

  it("carries the next whole value for each toggle", () => {
    const options = buildExternalEffectOptions(CATALOG, "read/write dev Postgres");
    expect(options[0]?.toggleValue).toBe("");
    expect(options[1]?.toggleValue).toBe("read/write dev Postgres\nssh build-01");
  });

  it("returns nothing for an empty catalog", () => {
    expect(buildExternalEffectOptions([], "a")).toEqual([]);
  });
});
