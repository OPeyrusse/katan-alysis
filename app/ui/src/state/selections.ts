// Naming rules of saved selections, kept pure so every rule is testable
// on its own: default names describe the selection, conflicts get a
// numeric suffix, renames follow the same rule.

/**
 * `base` if free, otherwise `base (2)`, `base (3)`, … — the first free
 * suffix wins, so deleting `base (2)` frees the name for the next save.
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}
