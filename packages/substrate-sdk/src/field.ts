/**
 * Field DSL. Spec: §6.1 (FieldDef), §4.1 (type declarations), §5.11
 * (coordinator plugins).
 *
 * Typed builders for the field shapes that coordinator plugins hand to
 * `installAutoCrud` / `defineNamespace`. Each builder returns the
 * `FieldDef` variant declared in `@mnmal-ai/substrate-types` verbatim — the DSL
 * is a thin ergonomic wrapper, no new runtime semantics.
 *
 * Defaults locked by the spec:
 *   - Scalars (string / number / boolean / date) default to `indexed: true`
 *     so the common case (filter on any scalar) pushes down to the substrate
 *     without per-field opt-in.
 *   - `crossRef` defaults to `indexed: true` as well — edges are expected to
 *     participate in where-clause filtering, so eager indexing matches the
 *     scalar default for consistency.
 *   - `crossRef.onDelete` defaults to `'set_null'` per §6.1: the least
 *     destructive policy keeps dangling rows alive with a nulled reference
 *     until the app decides otherwise.
 *   - `nullable` is omitted (undefined) unless the caller passes it. The
 *     flag is metadata consumed by the schema publisher / client decoder;
 *     leaving it absent keeps the schema JSON minimal.
 *
 * `struct.fields` is passed through unchanged — nested `field.crossRef` /
 * `field.list` compose without special handling.
 */

import type {
  FieldDef,
  FieldDefCrossRef,
  FieldDefList,
  FieldDefScalar,
  FieldDefStruct,
  OnDelete,
  OnMissing
} from '@mnmal-ai/substrate-types';

export interface ScalarFieldOptions {
  /**
   * Build a btree for this field. Default false: every field filters and
   * sorts without one, so declare it only where a read needs the speed.
   */
  indexed?: boolean;
  nullable?: boolean;
  /**
   * When true, this field is populated by the engine (not the caller) and
   * writes including it must be rejected at the autoCRUD layer. Intended
   * for engine-injected fields like `shortId`; plugin authors typically
   * should not set this on their own declarations.
   */
  readonly?: boolean;
  /**
   * Value autoCRUD `create` fills when the caller omits this field. A
   * non-nullable scalar with no `default` is REQUIRED on create — omitting it
   * is rejected (`missing_required_field`). Use `default` for fields whose
   * omission is legitimate (e.g. `archived: false`); leave it off for fields
   * that must be supplied. Not applied on update (a partial patch).
   */
  default?: string | number | boolean;
}

export interface DateFieldOptions extends ScalarFieldOptions {
  /**
   * Marks a server-managed timestamp. autoCRUD rejects a caller-supplied value
   * for the indicated lifecycle moment(s) and never stamps it — server-side
   * code does (e.g. a system writer via `applyUpdatePatch`). A create-gated
   * (`'create'` / `'both'`) field must be `nullable` or carry a `default`;
   * autoCRUD refuses to install one that could never be filled.
   */
  serverSet?: 'create' | 'update' | 'both';
}

export interface CrossRefFieldOptions {
  onDelete?: OnDelete;
  onMissing?: OnMissing;
  indexed?: boolean;
  nullable?: boolean;
  /**
   * Activation-spreading opt-in. When `spread: true`,
   * recall hits propagate a damped salience boost across this edge in both
   * directions. Default off; opt in per high-signal edge (e.g.
   * Decision.establishesConcept) to avoid polluting attention with low-signal
   * hops (e.g. Decision.sessionId).
   *
   * Mirrors FieldDefCrossRef.spread — see schema.ts for the spec rationale.
   */
  spread?: boolean;
  /**
   * Cross-type opt-in for backward expansion walks.
   * Requires `spread: true` (the builder throws otherwise).
   *
   * Mirrors FieldDefCrossRef.expandCrossType — see schema.ts for the spec
   * rationale + named win case.
   */
  expandCrossType?: boolean;
}

export interface StructFieldOptions {
  nullable?: boolean;
}

export interface ListFieldOptions {
  /**
   * Back the list field's `has` (element-membership) filter with a GIN, which
   * the substrate binary derives as a tracked migration at boot — no per-field
   * migration to author. Without it `has` still works, by scanning.
   * Default false. See `FieldDefList.indexed`.
   */
  indexed?: boolean;
  nullable?: boolean;
}

function makeScalar(
  type: FieldDefScalar['type'],
  opts: ScalarFieldOptions | undefined
): FieldDefScalar {
  const indexed = opts?.indexed ?? false;
  const def: FieldDefScalar = { kind: 'scalar', type, indexed };
  if (opts?.nullable !== undefined) def.nullable = opts.nullable;
  if (opts?.readonly !== undefined) def.readonly = opts.readonly;
  if (opts?.default !== undefined) def.default = opts.default;
  return def;
}

export interface VocabFieldOptions extends ScalarFieldOptions {
  /** alias -> canonical value; each canonical value must be in the vocabulary. */
  aliases?: Record<string, string>;
  /** `false` admits values outside the vocabulary. Default strict. */
  strict?: boolean;
  /** alias or canonical value -> sibling fields it implies; checked against the siblings at install. */
  implies?: Record<string, Record<string, unknown>>;
}

export interface JsonFieldOptions {
  nullable?: boolean;
  readonly?: boolean;
  /**
   * Derive a GIN over `(body -> field)` so path-filter `eq` / `in` / `has`
   * are index-served. Default false: every write to the type
   * pays GIN maintenance, so only fields that are actually filtered opt in.
   */
  indexed?: boolean;
}

export const field = {
  string(opts?: ScalarFieldOptions): FieldDefScalar {
    return makeScalar('string', opts);
  },
  number(opts?: ScalarFieldOptions): FieldDefScalar {
    return makeScalar('number', opts);
  },
  boolean(opts?: ScalarFieldOptions): FieldDefScalar {
    return makeScalar('boolean', opts);
  },
  date(opts?: DateFieldOptions): FieldDefScalar {
    const def = makeScalar('date', opts);
    if (opts?.serverSet !== undefined) def.serverSet = opts.serverSet;
    return def;
  },
  enum(values: readonly string[], opts?: ScalarFieldOptions): FieldDefScalar {
    const def = makeScalar('string', opts);
    def.enum = values;
    return def;
  },
  /**
   * A governed vocabulary: an enum whose synonyms are normalised to their
   * canonical value on write and in filters. `strict: false` admits unknown
   * values while still normalising aliases. Throws on an alias pointing
   * outside `values`, an alias that shadows a canonical value, or a default
   * outside `values`.
   */
  vocab(values: readonly string[], opts?: VocabFieldOptions): FieldDefScalar {
    const canonical = new Set(values.map((v) => v.toLowerCase()));
    for (const [alias, target] of Object.entries(opts?.aliases ?? {})) {
      if (!values.includes(target)) {
        throw new Error(
          `field.vocab: alias '${alias}' points to '${target}', which is not in the vocabulary`
        );
      }
      if (canonical.has(alias.toLowerCase())) {
        throw new Error(`field.vocab: alias '${alias}' shadows a canonical value`);
      }
    }
    const known = new Set([
      ...canonical,
      ...Object.keys(opts?.aliases ?? {}).map((a) => a.toLowerCase())
    ]);
    for (const key of Object.keys(opts?.implies ?? {})) {
      if (!known.has(key.toLowerCase())) {
        throw new Error(
          `field.vocab: implication key '${key}' is neither a value nor an alias of this field`
        );
      }
    }
    if (opts?.default !== undefined && !values.includes(String(opts.default))) {
      throw new Error(`field.vocab: default '${opts.default}' is not in the vocabulary`);
    }
    const { aliases, strict, implies, ...scalar } = opts ?? {};
    const def = makeScalar('string', scalar);
    def.enum = values;
    if (aliases !== undefined) def.aliases = aliases;
    if (strict === false) def.strict = false;
    if (implies !== undefined) def.implies = implies;
    return def;
  },
  crossRef(ns: string, type: string, opts?: CrossRefFieldOptions): FieldDefCrossRef {
    const def: FieldDefCrossRef = {
      kind: 'crossRef',
      ns,
      type,
      onDelete: opts?.onDelete ?? 'set_null',
      indexed: opts?.indexed ?? true
    };
    if (opts?.nullable !== undefined) def.nullable = opts.nullable;
    if (opts?.onMissing !== undefined) def.onMissing = opts.onMissing;
    // `expandCrossType` only governs cross-type backward walks on a spread
    // edge, so setting it without `spread: true` is a misconfiguration — fail
    // loud at build time rather than drop it silently.
    if (opts?.expandCrossType === true && opts.spread !== true) {
      throw new Error(
        'field.crossRef: expandCrossType requires spread: true (expandCrossType is meaningless without spread)'
      );
    }
    if (opts?.spread === true) {
      def.spread = true;
      if (opts.expandCrossType === true) def.expandCrossType = true;
    }
    return def;
  },
  struct(fields: Record<string, FieldDef>, opts?: StructFieldOptions): FieldDefStruct {
    const def: FieldDefStruct = { kind: 'struct', fields };
    if (opts?.nullable !== undefined) def.nullable = opts.nullable;
    return def;
  },
  list(of: FieldDef, opts?: ListFieldOptions): FieldDefList {
    const def: FieldDefList = { kind: 'list', of };
    if (opts?.indexed !== undefined) def.indexed = opts.indexed;
    if (opts?.nullable !== undefined) def.nullable = opts.nullable;
    return def;
  },
  /**
   * JSON body. Value round-trips unchanged. Filter a value INSIDE it with a
   * path predicate — `{ values: { path: ['year'], gt: 1990 } }` — which is
   * type-strict. `eq` / `in` / `has` are index-served only with
   * `{ indexed: true }`; everything else scans the type's rows. No ordering. When inner keys are known at schema time,
   * `field.struct` is still the better fit: declared, indexed, orderable.
   */
  json(opts?: JsonFieldOptions): FieldDefScalar {
    const def: FieldDefScalar = { kind: 'scalar', type: 'json', indexed: opts?.indexed === true };
    if (opts?.nullable !== undefined) def.nullable = opts.nullable;
    if (opts?.readonly !== undefined) def.readonly = opts.readonly;
    return def;
  }
};
