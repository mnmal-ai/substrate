import { canonicalVocabValue } from '@mnmal-ai/substrate-types';

/**
 * Internal autoCRUD utilities. Not exported from the package.
 */

export { resolveIdentity } from './resolve-identity.js';

import type { FieldDef, Id } from '@mnmal-ai/substrate-types';
import {
  CLIENT_SUPPLIED_SERVER_FIELD,
  ResolverFrameError,
  ROW_METADATA_FIELDS
} from '@mnmal-ai/substrate-types';

/**
 * Coerce a params-bag value into an `Id` (string | number). Anything else —
 * including undefined, null, objects, booleans — returns `undefined` so the
 * caller can surface a clean "params.id is required" error.
 */
export function coerceId(raw: unknown): Id | undefined {
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  return undefined;
}

/**
 * Reject any top-level `params` key not in the resolver's allowed set. Used
 * by every read-shaped autoCRUD resolver (`list`, `get`, `delete`, `purge`)
 * to surface typos like `params: { idd: '1' }` as `unknown_param` instead of
 * silently dropping them.
 *
 * Mutate-shaped resolvers (`create`, `update`) intentionally don't call this —
 * their `params` IS the row body, so "unknown" keys are extra body fields,
 * which is a separate concern from top-level param-shape validation.
 */
export function rejectUnknownParams(
  resolverName: string,
  typeName: string,
  params: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>
): void {
  if (!params) return;
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new ResolverFrameError(
        'unknown_param',
        `${resolverName}('${typeName}'): unknown param '${key}'. Allowed: ${[...allowed].sort().join(', ')}.`,
        { field: key, allowed: [...allowed].sort() }
      );
    }
  }
}

/**
 * Assert that the caller has not supplied any server-controlled fields.
 *
 * Tier-0: `_metadata` is rejected explicitly — the resolver's spread ordering
 * would otherwise silently discard a client-supplied value. `_deletedAt` is NOT
 * in this set: the update resolver throws `ReservedField('_deletedAt')` itself
 * to keep the dedicated error class.
 *
 * Tier-1: The four row-metadata fields (createdAt, updatedAt, createdBy,
 * updatedBy) are always rejected regardless of phase or field definitions.
 *
 * Tier-2: Any field with `kind: 'scalar'`, `type: 'date'`, and a `serverSet`
 * value that matches the current phase ('create' | 'update' | 'both') is
 * rejected.
 *
 * Throws `ResolverFrameError(CLIENT_SUPPLIED_SERVER_FIELD, ...)` on the first
 * rejected field found — consistent with the readonly-field check in the
 * create resolver.
 */
export function assertNoClientServerFields(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>,
  phase: 'create' | 'update'
): void {
  // Tier 0: `_metadata` parent struct (the four leaf fields are covered by
  // Tier 1 below).
  if ('_metadata' in params) {
    throw new ResolverFrameError(
      CLIENT_SUPPLIED_SERVER_FIELD,
      `Cannot supply server-controlled field '_metadata' on ${phase}`,
      { field: '_metadata', phase }
    );
  }
  // Tier 1: row metadata fields are always server-controlled.
  for (const f of ROW_METADATA_FIELDS) {
    if (f in params) {
      throw new ResolverFrameError(
        CLIENT_SUPPLIED_SERVER_FIELD,
        `Cannot supply server-controlled field '${f}' on ${phase}`,
        { field: f, phase }
      );
    }
  }
  // Tier 2: opt-in serverSet date fields.
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.kind !== 'scalar' || def.type !== 'date') continue;
    const ss = def.serverSet;
    if (!ss) continue;
    const fires = ss === 'both' || ss === phase;
    if (fires && name in params) {
      throw new ResolverFrameError(
        CLIENT_SUPPLIED_SERVER_FIELD,
        `Cannot supply server-controlled field '${name}' on ${phase}`,
        { field: name, phase }
      );
    }
  }
}

/**
 * Reject any enum-constrained field whose supplied value is outside its
 * declared vocabulary. Throws `ResolverFrameError('invalid_enum_value', ...)`, which the engine
 * translates into a per-key `env.errors` entry without rolling back the frame.
 *
 * Only fields present in `params` with a non-null, non-undefined value are
 * checked — absent or null values pass (absence on create is
 * `assertRequiredFields`' concern). Runs identically on create and update, so
 * memory and pg enforce the same vocabulary. A non-string value is rejected
 * with the same code — it can never be in-vocab.
 */
export function assertEnumValues(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>
): void {
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.kind !== 'scalar' || def.enum === undefined || def.strict === false) continue;
    if (!Object.hasOwn(params, name)) continue;
    const value = params[name];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || !def.enum.includes(value)) {
      const aliases =
        def.aliases === undefined ? '' : `; aliases: ${Object.keys(def.aliases).join(', ')}`;
      throw new ResolverFrameError(
        'invalid_enum_value',
        `'${name}' must be one of: ${def.enum.join(', ')}${aliases}`,
        {
          field: name,
          value,
          allowed: [...def.enum],
          ...(def.aliases !== undefined ? { aliases: { ...def.aliases } } : {})
        }
      );
    }
  }
}

/**
 * Reject any top-level `params` key that is not a declared field on the type.
 *
 * autoCRUD's create/update spread `{...params}` into the row body, so an
 * undeclared key — a typo, or a stale name after a field rename — would be
 * persisted verbatim, silently bypassing the very type contract the schema
 * exists to enforce. This makes the write path honour the registered FieldDef
 * map: the declared fields ARE the allow-list.
 *
 * Allowed = the declared field names plus `id` (caller-suppliable identity).
 * Server-controlled fields (`_metadata`, row metadata, serverSet dates) and
 * readonly fields are caught by their own earlier guards with more specific
 * codes; callers run this LAST so those codes win. Only TOP-LEVEL keys are
 * checked — struct interiors are intentionally open (they grow additively
 * without a schema migration, e.g. a `meta` struct), so nested keys
 * pass untouched.
 *
 * Throws `ResolverFrameError('unknown_field', ...)` on the first stray key,
 * mirroring the read-path `unknown_param` rejection.
 */
export function assertNoUnknownFields(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>,
  phase: 'create' | 'update'
): void {
  for (const key of Object.keys(params)) {
    if (key === 'id') continue;
    if (Object.hasOwn(fieldDefs, key)) continue;
    const allowed = [...new Set(['id', ...Object.keys(fieldDefs)])].sort();
    throw new ResolverFrameError(
      'unknown_field',
      `Cannot ${phase} with undeclared field '${key}'. Declared fields: ${allowed.join(', ')}.`,
      { field: key, phase, allowed }
    );
  }
}

/**
 * `undefined` is absence, not a value: JSON cannot carry it, so an in-process
 * `{ name: undefined }` must mean what the wire would — the key was not sent.
 * Without this, `name in params` counted it as supplied and the required-field
 * check let an incomplete row through. Returns a copy.
 */
export function dropUndefinedParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
}

/**
 * Refuse an explicit `null` on a non-nullable scalar, on create and update
 * alike. Presence is not completeness: a null passes `assertRequiredFields`'
 * key check and would store a row the type says cannot exist. A
 * `default` does not excuse it — the default fills an OMITTED key, and a
 * supplied null always wins over it. Names every offending field.
 */
export function assertNoNullOnNonNullable(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>,
  phase: 'create' | 'update'
): void {
  const offending: string[] = [];
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (name === 'id' || def.kind !== 'scalar' || def.nullable === true) continue;
    if (Object.hasOwn(params, name) && params[name] === null) offending.push(name);
  }
  if (offending.length === 0) return;
  const first = offending[0]!;
  const names = offending.map((n) => `'${n}'`).join(', ');
  throw new ResolverFrameError(
    'null_not_allowed',
    `Cannot ${phase} with null for non-nullable field${offending.length === 1 ? '' : 's'} ${names} — omit ${offending.length === 1 ? 'it' : 'them'} or send a value.`,
    { field: first, fields: offending, phase }
  );
}

// ISO 8601 date or date-time, the subset pg's timestamptz input also accepts.
// Anchored and free of nested quantifiers, so no backtracking blow-up. pg
// caps a zone offset at ±15:59 ("time zone displacement out of range").
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?)?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)?$/;

/**
 * Is this a timestamp pg will cast? `Date.parse` alone is not the test: it
 * accepts `"1"` (2001), `"Oct 21 2026"`, and rolls `"2026-02-30"` to March,
 * all of which pg's `::timestamptz` rejects, which is the failure this guards.
 */
function isIsoTimestamp(v: string): boolean {
  const m = ISO_TIMESTAMP.exec(v);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false; // pg has no year 0000
  // A day that exists in that month. setUTCFullYear, not Date.UTC, which maps
  // years 0-99 onto 1900-1999 and so would judge 0004-02-29 by 1904.
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d);
  return probe.getUTCDate() === d;
}

/**
 * Refuse a supplied value whose JS type does not match a `number`, `boolean`
 * or `date` scalar. pg sorts and date-filters these by casting
 * `body->>field` to numeric, boolean or timestamptz, so one stored
 * `dueAt: "next week"` fails every such read of the type, for every caller.
 * `string` and `json` fields are left alone: nothing casts them. `null` is
 * the null guard's business, not this one's.
 */
export function assertScalarTypes(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>,
  phase: 'create' | 'update'
): void {
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.kind !== 'scalar' || !Object.hasOwn(params, name)) continue;
    const v = params[name];
    if (v === null) continue;
    const ok =
      def.type === 'number'
        ? typeof v === 'number' && Number.isFinite(v)
        : def.type === 'boolean'
          ? typeof v === 'boolean'
          : def.type === 'date'
            ? typeof v === 'string'
              ? isIsoTimestamp(v)
              : v instanceof Date && Number.isFinite(v.getTime())
            : true;
    if (!ok) {
      throw new ResolverFrameError(
        'invalid_field_type',
        `Cannot ${phase} '${name}' with ${JSON.stringify(v)}: expected a ${def.type === 'date' ? 'date (ISO 8601 string)' : def.type}.`,
        { field: name, expected: def.type, phase }
      );
    }
  }
}

/**
 * Fill `create` defaults: for every declared scalar field with a `default` that
 * the caller omitted, set it on `params`. Mutates the supplied bag in place
 * (the create resolver passes a fresh `{ ...args.params }`). A caller-supplied
 * value — including an explicit `null` on a nullable field — always wins; only
 * genuinely-absent keys receive the default. Create-only: update is a partial
 * patch, so unsent fields must stay untouched, not be reset to defaults.
 */
export function applyScalarDefaults(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>
): void {
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.kind !== 'scalar' || def.default === undefined) continue;
    if (!Object.hasOwn(params, name)) params[name] = def.default;
  }
}

/**
 * Enforce required scalars on `create`: a non-nullable scalar with no `default`
 * MUST be supplied. This is how "required" is expressed — the absence of both
 * `nullable` and `default` means the caller has to provide a value, and
 * omitting it fails loud instead of silently writing a partial row (the empty
 * `{id}`-only rows this guard exists to prevent).
 *
 * Run AFTER applyScalarDefaults so a defaulted field counts as supplied.
 * Scoped to scalars: struct / list / crossRef required-ness is a separate
 * concern (crossRefs are nullable-by-policy via onDelete). readonly fields
 * (engine-allocated, e.g. shortId) and create-gated serverSet date fields
 * (which clients may not supply) are exempt. Create-only.
 *
 * Throws `ResolverFrameError('missing_required_field', ...)` naming EVERY
 * missing field, not just the first, so one malformed create costs one
 * round-trip. `details.field` carries the first missing name; `details.fields`
 * is the complete list.
 */
export function assertRequiredFields(
  params: Record<string, unknown>,
  fieldDefs: Record<string, FieldDef>
): void {
  const missing: string[] = [];
  for (const [name, def] of Object.entries(fieldDefs)) {
    // `id` is engine-generated (randomUUID) when omitted — never required.
    if (name === 'id') continue;
    if (def.kind !== 'scalar') continue;
    if (def.nullable === true || def.default !== undefined || def.readonly === true) continue;
    // Clients may not supply a create-gated serverSet field, so it cannot be
    // required of them; assertServerSetFieldsFillable keeps such fields
    // nullable or defaulted at install time.
    if (def.type === 'date' && (def.serverSet === 'create' || def.serverSet === 'both')) continue;
    if (!Object.hasOwn(params, name)) missing.push(name);
  }
  if (missing.length === 0) return;
  const first = missing[0]!;
  const message =
    missing.length === 1
      ? `Cannot create without required field '${first}' (non-nullable, no default).`
      : `Cannot create without required fields ${missing.map((n) => `'${n}'`).join(', ')} (non-nullable, no default).`;
  throw new ResolverFrameError('missing_required_field', message, {
    field: first,
    fields: missing,
    phase: 'create'
  });
}

/**
 * Every vocabulary implication must name a field the type declares, with a
 * value that field accepts. Checked at install, where the siblings are known;
 * `field.vocab` alone cannot see them.
 */
export function assertVocabImplications(
  typeName: string,
  fieldDefs: Record<string, FieldDef>
): void {
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.kind !== 'scalar' || def.implies === undefined) continue;
    for (const [key, siblings] of Object.entries(def.implies)) {
      for (const [sibling, value] of Object.entries(siblings)) {
        const sibDef = fieldDefs[sibling];
        if (sibDef === undefined) {
          throw new Error(
            `${typeName}.${name}: '${key}' implies field '${sibling}', which ${typeName} does not declare`
          );
        }
        if (sibDef.kind === 'scalar' && sibDef.enum !== undefined && sibDef.strict !== false) {
          const canonical = canonicalVocabValue(sibDef, value);
          if (typeof canonical !== 'string' || !sibDef.enum.includes(canonical)) {
            throw new Error(
              `${typeName}.${name}: '${key}' implies ${sibling} '${String(value)}', which ${sibling} does not accept`
            );
          }
        }
      }
    }
  }
}

/**
 * Reject a type whose autoCRUD create could never fill a field: a non-nullable,
 * non-defaulted, non-readonly scalar date with `serverSet` of `'create'` or
 * `'both'`. Clients may not supply it on create and autoCRUD does not stamp
 * serverSet fields, so every create would write a row without it.
 *
 * Throws a plain `Error` naming the type and every offending field.
 */
export function assertServerSetFieldsFillable(
  typeName: string,
  fieldDefs: Record<string, FieldDef>
): void {
  const unfillable: string[] = [];
  for (const [name, def] of Object.entries(fieldDefs)) {
    if (def.kind !== 'scalar' || def.type !== 'date') continue;
    if (def.serverSet !== 'create' && def.serverSet !== 'both') continue;
    if (def.nullable === true || def.default !== undefined || def.readonly === true) continue;
    unfillable.push(name);
  }
  if (unfillable.length === 0) return;
  const names = unfillable.map((n) => `'${n}'`).join(', ');
  throw new Error(
    `type '${typeName}': serverSet field(s) ${names} are non-nullable with no default, ` +
      'but clients may not supply them on create and autoCRUD does not stamp serverSet fields, ' +
      'so autoCRUD create could never fill them. Declare them `nullable: true` and stamp them ' +
      'from server-side code, or give them a `default`.'
  );
}
