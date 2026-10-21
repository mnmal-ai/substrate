import { ResolverFrameError } from './errors.js';
import type { FieldDef } from './schema.js';

/**
 * A vocabulary value in its canonical form: an alias becomes its target, and a
 * canonical value differing only in case takes the declared casing. Anything
 * else is returned unchanged, for `assertEnumValues` to judge.
 */
export function canonicalVocabValue(def: FieldDef, value: unknown): unknown {
  if (def.kind !== 'scalar' || def.enum === undefined || typeof value !== 'string') return value;
  const lower = value.toLowerCase();
  for (const [alias, target] of Object.entries(def.aliases ?? {})) {
    if (alias.toLowerCase() === lower) return target;
  }
  return def.enum.find((v) => v.toLowerCase() === lower) ?? value;
}

/** The siblings `value` implies on `def`, matched case-insensitively, or undefined. */
export function vocabImplication(
  def: FieldDef,
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (def.kind !== 'scalar' || def.implies === undefined || typeof value !== 'string')
    return undefined;
  const lower = value.toLowerCase();
  for (const [key, siblings] of Object.entries(def.implies)) {
    if (key.toLowerCase() === lower) return siblings;
  }
  return undefined;
}

/**
 * `params` with every vocabulary field's value in canonical form, and the
 * siblings an alias implies filled in. Implications are read from the RAW
 * value, before canonicalising: `done` and `cancelled` may share a canonical
 * value and differ only in what they imply. Throws `conflicting_implication`
 * when the caller supplied a sibling that disagrees. Returns a copy.
 */
export function normaliseVocabValues(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>
): Record<string, unknown> {
  const out = { ...params };
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (!(name in params)) continue;
    const implied = vocabImplication(def, params[name]);
    if (implied === undefined) continue;
    for (const [sibling, value] of Object.entries(implied)) {
      const sibDef = fieldDefs[sibling];
      if (!(sibling in params)) {
        out[sibling] = value;
        continue;
      }
      const supplied =
        sibDef === undefined ? params[sibling] : canonicalVocabValue(sibDef, params[sibling]);
      const wanted = sibDef === undefined ? value : canonicalVocabValue(sibDef, value);
      if (supplied !== wanted) {
        throw new ResolverFrameError(
          'conflicting_implication',
          `'${name}: ${String(params[name])}' implies ${sibling} '${String(wanted)}', but '${String(params[sibling])}' was supplied`,
          { field: name, value: params[name], implies: { ...implied }, conflict: sibling }
        );
      }
    }
  }
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (name in out) out[name] = canonicalVocabValue(def, out[name]);
  }
  return out;
}

/** Operators whose operand is a value (or list of values) of the field itself. */
const LIST_OPS = new Set(['in', 'nin']);

/**
 * Every spelling a row may have STORED for `value`: its canonical form plus
 * each alias that targets it. Rows written before a vocabulary (or an alias)
 * existed keep their old spelling until a backfill rewrites them, so a filter
 * on the canonical value must match those too. Unknown values pass through.
 */
export function storedVocabSpellings(def: FieldDef, value: unknown): unknown[] {
  const canonical = canonicalVocabValue(def, value);
  if (def.kind !== 'scalar' || typeof canonical !== 'string' || !def.enum?.includes(canonical))
    return [canonical];
  const aliases = Object.entries(def.aliases ?? {})
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return [canonical, ...aliases];
}

const spellingsOf = (def: FieldDef, values: unknown[]): unknown[] => [
  ...new Set(values.flatMap((v) => storedVocabSpellings(def, v)))
];

/**
 * A `where` clause that means the same over stored rows whatever spelling
 * they carry, through AND / OR / NOT:
 *
 * - `eq` / `in` match the canonical value and every alias stored for it;
 *   `neq` / `nin` exclude them all.
 * - `eq` on an alias that implies siblings (`done` -> closed + completed)
 *   matches a row stored as that literal alias, OR a row with any spelling
 *   of the canonical value whose implied siblings also hold.
 *
 * Other operators are left alone.
 */
export function normaliseVocabWhere(where: unknown, fieldDefs: Record<string, FieldDef>): unknown {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return where;
  const out: Record<string, unknown> = {};
  const extra: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if ((key === 'AND' || key === 'OR') && Array.isArray(value)) {
      out[key] = value.map((w) => normaliseVocabWhere(w, fieldDefs));
    } else if (key === 'NOT') {
      out[key] = normaliseVocabWhere(value, fieldDefs);
    } else {
      const def = fieldDefs[key];
      if (
        def === undefined ||
        def.kind !== 'scalar' ||
        def.enum === undefined ||
        value === null ||
        typeof value !== 'object'
      ) {
        out[key] = value;
        continue;
      }
      const pred: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
        const implied = op === 'eq' ? vocabImplication(def, operand) : undefined;
        if (implied !== undefined) {
          const siblings = Object.entries(implied).map(([sibling, v]) => {
            const sibDef = fieldDefs[sibling];
            return sibDef === undefined
              ? { [sibling]: { eq: v } }
              : { [sibling]: { in: storedVocabSpellings(sibDef, v) } };
          });
          extra.push({
            OR: [
              { [key]: { eq: operand } },
              { AND: [{ [key]: { in: storedVocabSpellings(def, operand) } }, ...siblings] }
            ]
          });
          continue;
        }
        if (op === 'eq') pred.in = spellingsOf(def, [operand]);
        else if (op === 'neq') pred.nin = spellingsOf(def, [operand]);
        else if (LIST_OPS.has(op) && Array.isArray(operand)) pred[op] = spellingsOf(def, operand);
        else pred[op] = operand;
      }
      if (Object.keys(pred).length > 0) out[key] = pred;
    }
  }
  if (extra.length === 0) return out;
  return Object.keys(out).length === 0 && extra.length === 1 ? extra[0] : { AND: [out, ...extra] };
}
