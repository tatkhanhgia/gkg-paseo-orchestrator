// COMPAT(pluginRoleLaunchHookReceipt): added in v0.8.0-paseo.6, remove after 2027-04-19.
// Clients that predate "plugin-role-launch-hook" parse injectionMethod as a closed enum and
// reject the whole message. Deepest holder: message > payload > entries > [i] > agent > roleBinding.
const MAX_DEPTH = 5;

export function isPluginRoleLaunchHookReceipt(receipt: unknown): boolean {
  const method = (receipt as { injectionMethod?: unknown } | null)?.injectionMethod;
  return method === "plugin-role-launch-hook";
}

/** Returns the same reference when nothing needs omitting. */
export function omitPluginRoleLaunchHookReceipts<T>(value: T, depth = 0): T {
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => omitPluginRoleLaunchHookReceipts(item, depth + 1));
    return items.some((item, index) => item !== value[index]) ? (items as T) : value;
  }
  const entries = Object.entries(value);
  const kept = entries.flatMap(([key, child]) =>
    key === "roleBinding" && isPluginRoleLaunchHookReceipt(child)
      ? []
      : [[key, omitPluginRoleLaunchHookReceipts(child, depth + 1)] as const],
  );
  const unchanged = kept.length === entries.length && kept.every(([, c], i) => c === entries[i][1]);
  return unchanged ? value : (Object.fromEntries(kept) as T);
}
