/**
 * A lookup into a plain-object record by a user-supplied key. Inherited
 * names (`constructor`, `__proto__`, `toString`) are not entries.
 */
export function own<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
  return rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;
}
