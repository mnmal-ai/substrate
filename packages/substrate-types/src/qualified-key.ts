/**
 * Parser for qualified frame keys (`<namespace>/<name>`).
 *
 * Returns `null` for a missing slash, an empty namespace (`/Type`) or an
 * empty name (`ns/`). Never return a stub `{ ns: '' }` instead — that drops
 * the failure signal and routes garbage through downstream lookups.
 */

export interface ParsedKey {
  ns: string;
  name: string;
}

export function parseQualifiedKey(key: string): ParsedKey | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return { ns: key.slice(0, slash), name: key.slice(slash + 1) };
}

/**
 * Companion formatter for `parseQualifiedKey`: returns the
 * `<namespace>/<name>` frame-key string.
 */
export function formatQualifiedKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}
