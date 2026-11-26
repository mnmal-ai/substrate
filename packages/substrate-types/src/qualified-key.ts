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

/** The parts of a walk `in` reference, `<namespace>/<Type>.<field>`. */
export interface ParsedWalkRef {
  ns: string;
  type: string;
  /** Everything after the first dot that follows the type. */
  field: string;
}

const WALK_REF = /^([^/]+)\/([^./]+)\.(.+)$/;

/**
 * Parser for a walk `in` reference (`<namespace>/<Type>.<field>`). Returns
 * `null` when the namespace, the type or the field is missing.
 */
export function parseWalkRef(ref: string): ParsedWalkRef | null {
  const m = WALK_REF.exec(ref);
  if (m === null) return null;
  const [, ns, type, field] = m as unknown as [string, string, string, string];
  return { ns, type, field };
}
