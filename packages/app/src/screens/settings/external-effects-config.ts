import type { ExternalEffectCatalogEntry } from "@getpaseo/protocol/external-effect-catalog";

export const EXTERNAL_EFFECT_CATALOG_LIMIT = 64;
export const EXTERNAL_EFFECT_GRANT_MAX_LENGTH = 500;
export const EXTERNAL_EFFECT_LABEL_MAX_LENGTH = 120;

/**
 * Ids are generated from the label and never shown. They exist so a grant keeps one durable
 * identity while its wording is edited, which is what a future enforcement gate would key off.
 */
export function createCatalogEntryId(label: string, takenIds: readonly string[]): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56);
  const base = slug.length > 0 ? slug : "grant";
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Rows carry this prefix until they are saved, when the label finally decides their id. */
const DRAFT_ID_PREFIX = "draft:";

export function addCatalogEntry(
  entries: readonly ExternalEffectCatalogEntry[],
): ExternalEffectCatalogEntry[] {
  return [...entries, { id: `${DRAFT_ID_PREFIX}${Date.now()}`, label: "", grant: "" }];
}

export function updateCatalogEntry(
  entries: readonly ExternalEffectCatalogEntry[],
  id: string,
  patch: Partial<Pick<ExternalEffectCatalogEntry, "label" | "grant">>,
): ExternalEffectCatalogEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
}

export function removeCatalogEntry(
  entries: readonly ExternalEffectCatalogEntry[],
  id: string,
): ExternalEffectCatalogEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

/**
 * Blank rows are dropped rather than rejected: adding a row then leaving it empty is the normal way
 * a Human changes their mind, and failing the whole save over it would be hostile.
 */
export function normalizeCatalogForSave(
  entries: readonly ExternalEffectCatalogEntry[],
): ExternalEffectCatalogEntry[] {
  const filled = entries
    .map((entry) => ({
      id: entry.id,
      label: entry.label.trim(),
      grant: entry.grant.trim(),
    }))
    .filter((entry) => entry.label.length > 0 && entry.grant.length > 0);

  const takenIds = filled
    .filter((entry) => !entry.id.startsWith(DRAFT_ID_PREFIX))
    .map((entry) => entry.id);
  // `filled` rows are fresh objects from the map above, so settling ids in place stays local.
  for (const entry of filled) {
    if (entry.id.startsWith(DRAFT_ID_PREFIX)) {
      entry.id = createCatalogEntryId(entry.label, takenIds);
      takenIds.push(entry.id);
    }
  }
  return filled;
}

/** The one message shown under the list, or null when the draft is saveable. */
export function catalogValidationError(
  entries: readonly ExternalEffectCatalogEntry[],
): string | null {
  const halfFilled = entries.find(
    (entry) =>
      entry.label.trim().length > 0 !== entry.grant.trim().length > 0 &&
      (entry.label.trim().length > 0 || entry.grant.trim().length > 0),
  );
  if (halfFilled) {
    return "Every grant needs both a name and the access text.";
  }
  const normalized = normalizeCatalogForSave(entries);
  if (normalized.length > EXTERNAL_EFFECT_CATALOG_LIMIT) {
    return `At most ${EXTERNAL_EFFECT_CATALOG_LIMIT} grants.`;
  }
  const grants = normalized.map((entry) => entry.grant);
  if (new Set(grants).size !== grants.length) {
    return "Two grants have the same access text.";
  }
  const tooLong = normalized.find(
    (entry) =>
      entry.grant.length > EXTERNAL_EFFECT_GRANT_MAX_LENGTH ||
      entry.label.length > EXTERNAL_EFFECT_LABEL_MAX_LENGTH,
  );
  if (tooLong) {
    return `Keep names under ${EXTERNAL_EFFECT_LABEL_MAX_LENGTH} and access text under ${EXTERNAL_EFFECT_GRANT_MAX_LENGTH} characters.`;
  }
  return null;
}
