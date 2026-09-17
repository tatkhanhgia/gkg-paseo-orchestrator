import type { ExternalEffectCatalogEntry } from "@getpaseo/protocol/external-effect-catalog";

import type { DraftAgentTextFeatureOption } from "@/composer/agent-controls";

/**
 * The composer keeps external access grants as one newline-separated string because that is what
 * the assignment contract consumes. The catalog is a convenience layer on top of that string:
 * checking an entry appends its grant line, unchecking removes it, and free-typed lines survive
 * both. Nothing here changes the wire shape.
 */
export function parseExternalEffects(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split("\n")
        .map((grant) => grant.trim())
        .filter(Boolean),
    ),
  );
}

export function summarizeExternalEffects(grants: readonly string[]): string {
  if (grants.length === 0) return "No external access";
  if (grants.length === 1) return grants[0] as string;
  return `${grants.length} external grants`;
}

/** The value the feature should take when `grant` is toggled against the current value. */
export function toggleExternalEffectGrant(value: string, grant: string): string {
  const normalized = grant.trim();
  const grants = parseExternalEffects(value);
  const next = grants.includes(normalized)
    ? grants.filter((entry) => entry !== normalized)
    : [...grants, normalized];
  return next.join("\n");
}

/**
 * Catalog entries projected for the sheet. Each option carries the whole next value rather than a
 * grant, so the control that renders it never has to know what an external effect is.
 */
export function buildExternalEffectOptions(
  catalog: readonly ExternalEffectCatalogEntry[],
  value: string,
): DraftAgentTextFeatureOption[] {
  const selected = new Set(parseExternalEffects(value));
  return catalog.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.grant,
    selected: selected.has(entry.grant.trim()),
    toggleValue: toggleExternalEffectGrant(value, entry.grant),
  }));
}
