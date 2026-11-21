/**
 * A sketch value as its field expects it. The parser keeps bare values as
 * strings, so this reads numbers, booleans and int64s out of them; the JSON
 * form may already carry numbers and booleans.
 */

import {
  type ActValue,
  canonicalVocabValue,
  type FieldDef,
  isInt16,
  isInt32,
  isIsoInstant,
  parseInt64
} from '@mnmal-ai/substrate-types';

export type Coerced = { ok: true; value: unknown } | { ok: false; problem: string };

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const INT = /^-?(0|[1-9]\d*)$/;

const ok = (value: unknown): Coerced => ({ ok: true, value });

/** Longest token a refusal echoes or measures against its choices. */
export const TOKEN_ECHO = 64;
/** `s`, or its first `TOKEN_ECHO` characters and `…` when longer. */
export const clipToken = (s: string): string =>
  s.length > TOKEN_ECHO ? `${s.slice(0, TOKEN_ECHO)}…` : s;

function isNullable(def: FieldDef): boolean {
  if (def.kind === 'crossRef') return def.nullable ?? def.onDelete === 'set_null';
  if (def.kind === 'scalar') return def.nullable === true || def.type === 'json';
  return def.nullable === true;
}

export function coerceValue(def: FieldDef, value: ActValue): Coerced {
  const fail = (what: string): Coerced => ({
    ok: false,
    problem: `${typeof value === 'string' ? `'${clipToken(value)}'` : String(value)} is not ${what}`
  });
  if (value === null)
    return isNullable(def) ? ok(null) : { ok: false, problem: 'null is not allowed' };
  if (def.kind === 'list') {
    const out: unknown[] = [];
    for (const el of Array.isArray(value) ? value : [value]) {
      const r = coerceValue(def.of, el);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }
  if (Array.isArray(value)) return { ok: false, problem: 'a list is not allowed' };
  if (def.kind === 'struct')
    return { ok: false, problem: 'a struct cannot be written from a sketch' };
  if (def.kind === 'crossRef') {
    const id = typeof value === 'number' ? String(value) : value;
    if (typeof id !== 'string') return fail('a reference');
    if (id === '') return { ok: false, problem: 'empty reference' };
    // `#N` and `$name` are read by the compiler where a step can resolve them; here only a full id fits.
    return /^[#$]/.test(id) ? fail('a full id') : ok(id);
  }
  switch (def.type) {
    case 'string': {
      if (typeof value !== 'string') return fail('a string');
      if (def.enum === undefined) return ok(value);
      // Checked in canonical form but kept raw: the write path and the list
      // resolver normalise it, reading an alias's implications from the raw value.
      return def.strict === false || def.enum.includes(canonicalVocabValue(def, value) as string)
        ? ok(value)
        : fail(`one of ${def.enum.join('|')}`);
    }
    case 'number': {
      const n = typeof value === 'string' && NUMBER.test(value) ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) ? ok(n) : fail('a number');
    }
    case 'int16':
    case 'int32': {
      const n = typeof value === 'string' && INT.test(value) ? Number(value) : value;
      return (def.type === 'int16' ? isInt16(n) : isInt32(n)) ? ok(n) : fail(`an ${def.type}`);
    }
    case 'int64': {
      const n = parseInt64(value);
      return n === undefined ? fail('an int64') : ok(n);
    }
    case 'boolean': {
      const b = value === 'true' ? true : value === 'false' ? false : value;
      return typeof b === 'boolean' ? ok(b) : fail('a boolean');
    }
    case 'date':
      // The write path and the filter validator accept only a full instant, so refuse anything less here.
      return typeof value === 'string' && isIsoInstant(value)
        ? ok(value)
        : fail('an ISO 8601 instant');
    case 'json':
      return ok(value);
  }
}
