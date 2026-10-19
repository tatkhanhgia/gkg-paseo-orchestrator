// COMPAT(pluginRoleLaunchHookReceipt): added in v0.8.0-paseo.6, remove after 2027-04-19.
// Old clients parse injectionMethod as a closed enum and reject the whole message.
const HOOK = "plugin-role-launch-hook";
const MAX_DEPTH = 5; // message > payload > entries > [i] > agent > roleBinding

export function isPluginRoleLaunchHookReceipt(receipt: unknown): boolean {
  return (receipt as { injectionMethod?: unknown } | null)?.injectionMethod === HOOK;
}

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
