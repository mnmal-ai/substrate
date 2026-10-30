/**
 * Typed edge walk validation (spec 2026-10-24-typed-edge-walks §1, §2).
 *
 * Checks `_walk` nodes, `_agg` aggregates (where-side and in `fields`),
 * nested `{ _walk }` selections, `$ref` operands, and the frame params
 * `count`, `aggregate`, `bucket` and `derive`. The recursion into a walk's far-side `where` is handed back to the
 * filter validator, so the far type's fields and operators are checked exactly
 * as a top-level read of that type would be.
 */

import type { FieldDef, FieldKind, TypeSchema, WalkNode } from '@mnmal-ai/substrate-types';
import { walkGrammarPath } from '../walk-gate.js';
import { FilterValidationError } from './validator.js';

export const MAX_WALK_DEPTH = 3;
/** Joint quantification enumerates the product of the bound walks' neighbourhoods, so cap the factors. */
export const MAX_GROUP_BINDINGS = 3;
export const MAX_FRAME_BINDINGS = 6;

const COMPARISON_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const WALK_KEYS = new Set(['as', 'in', 'out', 'where', 'quantifier', 'pick']);

/** What a walk, or a `$ref` inside one, can see. */
export interface WalkScope {
  /** The frame's namespace; walks never leave it. Absent: walks are unavailable here. */
  namespace?: string;
  schemaOf?: (type: string) => TypeSchema | undefined;
  /** The type the current where-clause filters, and its fields. */
  typeName?: string;
  fields: Record<string, FieldDef>;
  /** Hops walked to reach the current where-clause; the seed is 0. */
  depth: number;
  /** Visible bindings: `$` (the seed row) and each `any` walk's `as`. */
  bindings: ReadonlyMap<string, Record<string, FieldDef>>;
  /** Bindings made under OR / NOT: named, but not referenceable from outside them. */
  hidden: ReadonlySet<string>;
  /** Set once inside an OR or NOT, where no binding may be referenced. */
  underOrNot: boolean;
  /** This where-object's AND group was already bound by an enclosing AND. */
  groupBound: boolean;
  /** The frame's `_agg` names and their value kinds, for `$ref: '_agg.<name>'`. */
  aggs?: ReadonlyMap<string, string>;
  /** `as` bindings made so far in this frame, shared by every scope derived from the seed. */
  frameBindings?: { count: number };
}

export type FieldLookup = (fields: Record<string, FieldDef>, name: string) => FieldDef | undefined;

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(
  code: ConstructorParameters<typeof FilterValidationError>[0],
  msg: string,
  path: string[]
): never {
  throw new FilterValidationError(code, msg, path);
}

/** A type's schema, or undefined for anything that is not one (e.g. a prototype key like `constructor`). */
function schemaIn(
  schemaOf: (type: string) => TypeSchema | undefined,
  type: string
): TypeSchema | undefined {
  const s: unknown = schemaOf(type);
  return isObj(s) && isObj(s.fields) ? (s as unknown as TypeSchema) : undefined;
}

export interface Hop {
  typeName: string;
  fields: Record<string, FieldDef>;
}

/**
 * Resolve a walk's `in` / `out` to the far type. Shared by `_walk` and the
 * where-side `_agg`, so both name edges the same way.
 */
export function resolveHop(node: Record<string, unknown>, path: string[], scope: WalkScope): Hop {
  const { namespace, schemaOf, typeName } = scope;
  if (namespace === undefined || schemaOf === undefined || typeName === undefined) {
    fail('walk_unknown_ref', 'walks are not available on this read', path);
  }
  if (scope.depth >= MAX_WALK_DEPTH) {
    fail('walk_too_deep', `a walk chains at most ${MAX_WALK_DEPTH} hops`, path);
  }
  const hasIn = node.in !== undefined;
  if (hasIn === (node.out !== undefined)) {
    fail('walk_unknown_ref', "a walk names exactly one of 'in' or 'out'", path);
  }
  const dir = hasIn ? 'in' : 'out';
  const spec = node[dir];
  const at = [...path, dir];
  if (typeof spec !== 'string') fail('walk_unknown_ref', `'${dir}' must be a string`, at);

  let farType: string;
  let fieldPath: string;
  let fieldOwner: Record<string, FieldDef>;
  if (dir === 'in') {
    const m = /^([^/]+)\/([^./]+)\.(.+)$/.exec(spec);
    if (m === null)
      fail('walk_unknown_ref', `'in' must be '<ns>/<Type>.<field>', got '${spec}'`, at);
    const [, ns, type, field] = m as unknown as [string, string, string, string];
    if (ns !== namespace) {
      fail('walk_cross_namespace', `a walk stays in namespace '${namespace}', not '${ns}'`, at);
    }
    const far = schemaIn(schemaOf, type);
    if (far === undefined) fail('walk_unknown_ref', `unknown type '${ns}/${type}'`, at);
    farType = type;
    fieldPath = field;
    fieldOwner = far.fields;
  } else {
    farType = '';
    fieldPath = spec;
    fieldOwner = scope.fields;
  }

  const [head = '', ...rest] = fieldPath.split('.');
  const def = Object.hasOwn(fieldOwner, head) ? fieldOwner[head] : undefined;
  if (rest.length > 0 && def?.kind === 'struct') {
    fail(
      'walk_unsupported_ref',
      `'${spec}' is a crossRef nested in a struct; walks follow top-level crossRefs`,
      at
    );
  }
  if (def?.kind === 'list' && def.of.kind === 'crossRef') {
    fail(
      'walk_unsupported_ref',
      `'${spec}' is a list of crossRefs; walks follow scalar crossRefs`,
      at
    );
  }
  if (rest.length > 0 || def === undefined || def.kind !== 'crossRef') {
    fail('walk_unknown_ref', `'${spec}' is not a crossRef field`, at);
  }
  if (def.ns !== namespace) {
    fail(
      'walk_cross_namespace',
      `'${spec}' points into namespace '${def.ns}'; a walk stays in '${namespace}'`,
      at
    );
  }
  if (dir === 'in') {
    if (def.type !== typeName) {
      fail('walk_unknown_ref', `'${spec}' points at '${def.type}', not '${typeName}'`, at);
    }
    return { typeName: farType, fields: fieldOwner };
  }
  const far = schemaIn(schemaOf, def.type);
  if (far === undefined) fail('walk_unknown_ref', `unknown type '${def.ns}/${def.type}'`, at);
  return { typeName: def.type, fields: far.fields };
}

/** The scope a walk's own `where` is validated in: the far type, one hop deeper, a fresh AND group. */
export function farScope(scope: WalkScope, hop: Hop): WalkScope {
  return {
    ...scope,
    typeName: hop.typeName,
    fields: hop.fields,
    depth: scope.depth + 1,
    groupBound: false
  };
}

const isAny = (n: Record<string, unknown>) =>
  (n.quantifier === undefined || n.quantifier === 'any') && n.pick === undefined;

function checkAs(node: Record<string, unknown>, path: string[]): void {
  if (node.as === undefined) return;
  if (!isAny(node)) {
    fail(
      'walk_quantifier',
      "only an 'any' walk may bind 'as'; none, all and pick walks cannot be referenced",
      [...path, 'as']
    );
  }
  if (typeof node.as !== 'string' || !IDENT.test(node.as)) {
    fail('walk_binding', "'as' must be an identifier", [...path, 'as']);
  }
}

/** `_walk` nodes in an AND group: the object's own key and, through AND, its conjuncts'. */
function groupWalks(
  where: unknown,
  path: string[],
  out: Array<[Record<string, unknown>, string[]]>
): void {
  if (!isObj(where)) return;
  if (isObj(where._walk)) out.push([where._walk, [...path, '_walk']]);
  if (Array.isArray(where.AND))
    where.AND.forEach((w, i) => {
      groupWalks(w, [...path, 'AND', String(i)], out);
    });
}

/** Every `as` anywhere below an OR / NOT in this group. */
function hiddenNames(where: unknown, under: boolean, out: Set<string>): void {
  if (Array.isArray(where)) {
    for (const w of where) hiddenNames(w, under, out);
    return;
  }
  if (!isObj(where)) return;
  for (const [k, v] of Object.entries(where)) {
    if (k === '_walk' && under && isObj(v) && typeof v.as === 'string') out.add(v.as);
    hiddenNames(v, under || k === 'OR' || k === 'NOT', out);
  }
}

/**
 * Bind an AND group: every `any` walk with `as` in it is visible to all its
 * siblings and their descendants (joint quantification), so bind them all
 * before any member is validated.
 */
export function bindGroup(where: unknown, path: string[], scope: WalkScope): WalkScope {
  const walks: Array<[Record<string, unknown>, string[]]> = [];
  groupWalks(where, path, walks);
  const hidden = new Set(scope.hidden);
  hiddenNames(where, false, hidden);
  if (walks.every(([n]) => n.as === undefined) && hidden.size === scope.hidden.size) {
    return { ...scope, groupBound: true };
  }
  const bound = walks.filter(([n]) => n.as !== undefined);
  if (bound.length > MAX_GROUP_BINDINGS) {
    fail(
      'walk_binding',
      `an AND group binds at most ${MAX_GROUP_BINDINGS} walks with 'as', got ${bound.length}`,
      path
    );
  }
  if (scope.frameBindings !== undefined) {
    scope.frameBindings.count += bound.length;
    if (scope.frameBindings.count > MAX_FRAME_BINDINGS) {
      fail('walk_binding', `a frame binds at most ${MAX_FRAME_BINDINGS} walks with 'as'`, path);
    }
  }
  const bindings = new Map(scope.bindings);
  for (const [node, at] of walks) {
    checkAs(node, at);
    if (typeof node.as !== 'string') continue;
    if (bindings.has(node.as)) fail('walk_binding', `'${node.as}' is already bound`, [...at, 'as']);
    bindings.set(node.as, resolveHop(node, at, scope).fields);
  }
  return { ...scope, bindings, hidden, groupBound: true };
}

const DATE_OR_NUMBER = new Set<FieldKind>(['scalar.number', 'scalar.date']);

/** A `_walk` node. `validateWhere` validates its far-side where in `farScope`. */
export function validateWalk(
  node: unknown,
  path: string[],
  scope: WalkScope,
  lookup: FieldLookup,
  kindOf: (def: FieldDef) => string,
  validateWhere: (where: unknown, path: string[], scope: WalkScope) => void
): void {
  if (!isObj(node)) fail('type_mismatch', '_walk expects a walk object', path);
  for (const k of Object.keys(node)) {
    if (!WALK_KEYS.has(k)) fail('type_mismatch', `unknown walk key '${k}'`, [...path, k]);
  }
  const q = node.quantifier;
  if (q !== undefined && q !== 'any' && q !== 'none' && q !== 'all') {
    fail('walk_quantifier', "quantifier must be 'any', 'none' or 'all'", [...path, 'quantifier']);
  }
  checkAs(node, path);
  const hop = resolveHop(node, path, scope);
  const pick = (node as WalkNode).pick;
  if (pick !== undefined && (q === 'none' || q === 'all')) {
    fail('walk_quantifier', `a pick walk picks one row; it takes no '${q}' quantifier`, [
      ...path,
      'quantifier'
    ]);
  }
  if (pick !== undefined) {
    const entries = isObj(pick) ? Object.entries(pick) : [];
    const [k, field] = entries[0] ?? [];
    if (entries.length !== 1 || (k !== 'latest' && k !== 'max' && k !== 'min')) {
      fail('type_mismatch', 'pick is one of { latest }, { max } or { min }', [...path, 'pick']);
    }
    const def = typeof field === 'string' ? lookup(hop.fields, field) : undefined;
    if (def === undefined)
      fail('unknown_field', `unknown field '${String(field)}' on '${hop.typeName}'`, [
        ...path,
        'pick',
        k
      ]);
    const kind = kindOf(def);
    if (k === 'latest' ? kind !== 'scalar.date' : !DATE_OR_NUMBER.has(kind as FieldKind)) {
      fail(
        'type_mismatch',
        `pick ${k} needs a ${k === 'latest' ? 'date' : 'number or date'} field, '${String(field)}' is ${kind}`,
        [...path, 'pick', k]
      );
    }
  }
  if (node.where !== undefined) validateWhere(node.where, [...path, 'where'], farScope(scope, hop));
}

/**
 * A `$ref` operand on a comparison. Resolves `$.f` (the seed row) or
 * `<as>.f` (a visible binding) and requires the same number / date kind as
 * the field it is compared with.
 */
export function validateRef(
  fieldKind: string,
  op: string,
  operand: Record<string, unknown>,
  path: string[],
  scope: WalkScope,
  lookup: FieldLookup,
  kindOf: (def: FieldDef) => string
): void {
  if (!COMPARISON_OPS.has(op)) {
    fail(
      'type_mismatch',
      `a $ref operand is allowed on eq, neq, gt, gte, lt and lte, not '${op}'`,
      path
    );
  }
  for (const [k, v] of Object.entries(operand)) {
    if (k === '$ref') continue;
    if ((k !== 'times' && k !== 'plus') || typeof v !== 'number' || !Number.isFinite(v)) {
      fail(
        'type_mismatch',
        `a $ref takes only numeric 'times' and 'plus' beside it, got '${k}'`,
        path
      );
    }
  }
  if (!DATE_OR_NUMBER.has(fieldKind as FieldKind)) {
    fail('ref_kind_mismatch', `a $ref compares number or date fields, not ${fieldKind}`, path);
  }
  // A date shifts by `plus` milliseconds; scaling one is meaningless.
  if (fieldKind === 'scalar.date' && operand.times !== undefined) {
    fail(
      'ref_kind_mismatch',
      "a $ref on a date field takes 'plus' (milliseconds), not 'times'",
      path
    );
  }
  const ref = operand.$ref;
  const m = typeof ref === 'string' ? /^([^.]+)\.(.+)$/.exec(ref) : null;
  if (m === null)
    fail(
      'ref_unresolved',
      `$ref must be '$.<field>', '<as>.<field>' or '_agg.<name>', got '${String(ref)}'`,
      path
    );
  const [, name, field] = m as unknown as [string, string, string];
  if (name === '_agg') {
    const aggKind = scope.aggs?.get(field);
    if (aggKind === undefined) {
      fail('ref_unresolved', `$ref '${ref}': no _agg '${field}' in this frame's fields`, path);
    }
    if (aggKind !== fieldKind) {
      fail(
        'ref_kind_mismatch',
        `$ref '${ref}' is ${aggKind}; it is compared with a ${fieldKind} field`,
        path
      );
    }
    return;
  }
  if (name !== '$' && (scope.underOrNot || (scope.hidden.has(name) && !scope.bindings.has(name)))) {
    fail(
      'walk_binding',
      `$ref '${ref}' crosses an OR or NOT; a binding is referenceable only within its AND group`,
      path
    );
  }
  const fields = scope.bindings.get(name);
  if (fields === undefined)
    fail('ref_unresolved', `$ref '${ref}': no binding '${name}' in scope`, path);
  const def = lookup(fields, field);
  if (def === undefined) fail('ref_unresolved', `$ref '${ref}': unknown field '${field}'`, path);
  const refKind = kindOf(def);
  if (refKind !== fieldKind) {
    fail(
      'ref_kind_mismatch',
      `$ref '${ref}' is ${refKind}; it is compared with a ${fieldKind} field`,
      path
    );
  }
}

/** What the frame-level checks need from the filter validator. */
export interface FrameHelpers {
  lookup: FieldLookup;
  kindOf: (def: FieldDef) => string;
  validateWhere: (where: unknown, path: string[], scope: WalkScope) => void;
  validateOrderBy: (orderBy: unknown, fields: Record<string, FieldDef>, path: string[]) => void;
}

const AGG_FNS = new Set(['count', 'avg', 'sum', 'min', 'max', 'latest']);
const WALK_AGG_KEYS = new Set(['in', 'out', 'where']);
const NO_KEYS = new Set<string>();

/**
 * One aggregate function over `owner`'s fields, returning its value kind:
 * `count`, `avg` and `sum` are numbers; `min`, `max` and `latest` take their
 * field's kind. `latest` picks a row, so only a per-row walk aggregate has it.
 */
function aggKind(
  agg: Record<string, unknown>,
  extra: ReadonlySet<string>,
  owner: Hop,
  path: string[],
  h: FrameHelpers,
  allowLatest: boolean
): string {
  for (const k of Object.keys(agg)) {
    if (!extra.has(k) && !AGG_FNS.has(k)) {
      fail('agg_invalid', `unknown aggregate key '${k}'`, [...path, k]);
    }
  }
  const fns = Object.keys(agg).filter((k) => AGG_FNS.has(k));
  if (fns.length !== 1) {
    fail(
      'agg_invalid',
      'an aggregate names exactly one of count, avg, sum, min, max or latest',
      path
    );
  }
  const [fn] = fns as [string];
  const at = [...path, fn];
  const v = agg[fn];
  const field = (name: unknown, p: string[], ok: (kind: string) => boolean, what: string) => {
    const def = typeof name === 'string' ? h.lookup(owner.fields, name) : undefined;
    if (def === undefined) {
      fail('agg_invalid', `unknown field '${String(name)}' on '${owner.typeName}'`, p);
    }
    const kind = h.kindOf(def);
    if (!ok(kind)) fail('agg_invalid', `${fn} needs ${what}; '${String(name)}' is ${kind}`, p);
    return kind;
  };
  switch (fn) {
    case 'count':
      if (v !== true) fail('agg_invalid', 'count takes true', at);
      return 'scalar.number';
    case 'avg':
    case 'sum':
      field(v, at, (k) => k === 'scalar.number', 'a number field');
      return 'scalar.number';
    case 'min':
    case 'max':
      return field(v, at, (k) => DATE_OR_NUMBER.has(k as FieldKind), 'a number or date field');
    default: {
      if (!allowLatest) {
        fail(
          'agg_invalid',
          'latest picks one row per seed row; a frame aggregate takes count, avg, sum, min or max',
          at
        );
      }
      if (!isObj(v) || Object.keys(v).some((k) => k !== 'by' && k !== 'value')) {
        fail('agg_invalid', 'latest takes { by: <dateField>, value: <field> }', at);
      }
      field(v.by, [...at, 'by'], (k) => k === 'scalar.date', 'a date field');
      return field(
        v.value,
        [...at, 'value'],
        (k) => k.startsWith('scalar.') && k !== 'scalar.json',
        'a scalar field'
      );
    }
  }
}

/** A walk aggregate (`fields._agg` entry or where-side `_agg`): its walk, far `where` and function. Returns its value kind. */
export function validateWalkAgg(
  agg: unknown,
  path: string[],
  scope: WalkScope,
  h: FrameHelpers
): string {
  if (!isObj(agg)) fail('agg_invalid', '_agg expects an aggregate object', path);
  const hop = resolveHop(agg, path, scope);
  const kind = aggKind(agg, WALK_AGG_KEYS, hop, path, h, true);
  if (agg.where !== undefined) h.validateWhere(agg.where, [...path, 'where'], farScope(scope, hop));
  return kind;
}

const NESTED_KEYS = new Set(['_walk', 'fields', 'where', 'orderBy', 'limit']);
/** Top-level row columns a nested row does not carry. */
const NESTED_ROW_ONLY = ['_metadata', 'shortId', '_deletedAt'] as const;

/** A nested `{ _walk, fields, where?, orderBy?, limit? }` selection. Its `limit` max is the engine's page max. */
function validateNested(
  sel: Record<string, unknown>,
  path: string[],
  scope: WalkScope,
  h: FrameHelpers
): void {
  for (const k of Object.keys(sel)) {
    if (!NESTED_KEYS.has(k))
      fail('type_mismatch', `unknown nested selection key '${k}'`, [...path, k]);
  }
  const walk = sel._walk;
  const wp = [...path, '_walk'];
  if (!isObj(walk)) fail('type_mismatch', '_walk expects { in | out, where? }', wp);
  for (const k of Object.keys(walk)) {
    if (!WALK_AGG_KEYS.has(k)) {
      fail('type_mismatch', `a nested _walk takes in, out and where, not '${k}'`, [...wp, k]);
    }
  }
  const hop = resolveHop(walk, wp, scope);
  const far = farScope(scope, hop);
  if (walk.where !== undefined) h.validateWhere(walk.where, [...wp, 'where'], far);
  if (sel.where !== undefined) h.validateWhere(sel.where, [...path, 'where'], far);
  if (sel.orderBy !== undefined) {
    for (const [i, clause] of (Array.isArray(sel.orderBy) ? sel.orderBy : []).entries()) {
      if (isObj(clause) && Object.hasOwn(clause, 'shortId')) {
        fail('unknown_field', 'shortId cannot order a nested list', [
          ...path,
          'orderBy',
          String(i),
          'shortId'
        ]);
      }
    }
    h.validateOrderBy(sel.orderBy, hop.fields, [...path, 'orderBy']);
  }
  const limit = sel.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0)) {
    fail('type_mismatch', 'limit must be a non-negative integer', [...path, 'limit']);
  }
  if (!isObj(sel.fields))
    fail('type_mismatch', 'a nested selection needs fields', [...path, 'fields']);
  for (const k of NESTED_ROW_ONLY) {
    if (Object.hasOwn(sel.fields, k)) {
      fail('unknown_field', `'${k}' is not available in nested selections`, [...path, 'fields', k]);
    }
  }
  validateSelection(sel.fields, [...path, 'fields'], far, h);
}

/**
 * A field selection's `_agg` and nested `{ _walk }` entries, which sit at the
 * top level of a selection only. Returns the `_agg` names and value kinds.
 */
export function validateSelection(
  fields: unknown,
  path: string[],
  scope: WalkScope,
  h: FrameHelpers
): Map<string, string> {
  const aggs = new Map<string, string>();
  if (!isObj(fields)) return aggs;
  for (const [name, sel] of Object.entries(fields)) {
    const at = [...path, name];
    if (name === '_agg') {
      if (!isObj(sel)) fail('agg_invalid', '_agg maps names to aggregates', at);
      // One _agg cannot reference another: validated with no _agg names in scope.
      const own = { ...scope, aggs: new Map<string, string>() };
      for (const [n, agg] of Object.entries(sel)) {
        if (!IDENT.test(n)) {
          fail('agg_invalid', `aggregate name '${n}' must be an identifier`, [...at, n]);
        }
        aggs.set(n, validateWalkAgg(agg, [...at, n], own, h));
      }
    } else if (isObj(sel) && Object.hasOwn(sel, '_walk')) {
      validateNested(sel, at, scope, h);
    } else if (isObj(sel)) {
      const deep = walkGrammarPath({ fields: sel });
      if (deep !== null) {
        fail(
          'walk_unsupported_ref',
          `'${String(deep.at(-1))}' is valid only at the top level of a type's selection`,
          [...at, ...deep.slice(1)]
        );
      }
    }
  }
  return aggs;
}

export interface FrameParams {
  count?: unknown;
  aggregate?: unknown;
  bucket?: unknown;
  derive?: unknown;
  cursor?: unknown;
  orderBy?: unknown;
  fields?: Record<string, unknown>;
}

/**
 * `count`, `aggregate`, `bucket` and `derive`, and what each excludes.
 * Returns the derive names `orderBy` may use as `$<name>`.
 */
export function validateFrameParams(
  p: FrameParams,
  scope: WalkScope,
  h: FrameHelpers
): ReadonlySet<string> {
  if (p.count !== undefined && typeof p.count !== 'boolean') {
    fail('type_mismatch', 'count takes true or false', ['count']);
  }
  if (p.count === true) {
    for (const k of ['aggregate', 'bucket', 'derive', 'orderBy', 'cursor'] as const) {
      if (p[k] !== undefined)
        fail('count_conflict', `count returns a count; it takes no '${k}'`, [k]);
    }
    for (const k of Object.keys(p.fields ?? {})) {
      if (k !== 'id') {
        fail('count_conflict', `count returns no rows; it selects only id, not '${k}'`, [
          'fields',
          k
        ]);
      }
    }
  }
  const seed: Hop = { typeName: scope.typeName ?? '', fields: scope.fields };
  if (p.aggregate !== undefined) {
    // `limit` stays: it caps the bucket rows.
    for (const k of ['derive', 'orderBy', 'cursor'] as const) {
      if (p[k] !== undefined) {
        fail('agg_invalid', `aggregate returns aggregate rows; it takes no '${k}'`, [k]);
      }
    }
    for (const k of Object.keys(p.fields ?? {})) {
      if (k !== 'id') {
        fail('agg_invalid', `aggregate returns aggregate rows; it selects only id, not '${k}'`, [
          'fields',
          k
        ]);
      }
    }
    if (!isObj(p.aggregate) || Object.keys(p.aggregate).length === 0) {
      fail('agg_invalid', 'aggregate maps names to aggregates', ['aggregate']);
    }
    for (const [n, agg] of Object.entries(p.aggregate)) {
      const at = ['aggregate', n];
      if (!IDENT.test(n) || (n === 'bucket' && p.bucket !== undefined)) {
        fail('agg_invalid', `aggregate name '${n}' must be an identifier other than bucket`, at);
      }
      if (!isObj(agg)) fail('agg_invalid', 'an aggregate is an object such as { count: true }', at);
      aggKind(agg, NO_KEYS, seed, at, h, false);
    }
  }
  if (p.bucket !== undefined) {
    const b = p.bucket;
    if (p.aggregate === undefined) {
      fail('bucket_invalid', 'bucket groups an aggregate; it needs aggregate', ['bucket']);
    }
    if (!isObj(b) || Object.keys(b).some((k) => k !== 'field' && k !== 'by')) {
      fail('bucket_invalid', 'bucket takes { field, by }', ['bucket']);
    }
    if (b.by !== 'day' && b.by !== 'hour') {
      fail('bucket_invalid', "bucket by is 'day' or 'hour'", ['bucket', 'by']);
    }
    const def = typeof b.field === 'string' ? h.lookup(scope.fields, b.field) : undefined;
    if (def === undefined || h.kindOf(def) !== 'scalar.date') {
      fail('bucket_invalid', `bucket field '${String(b.field)}' is not a date field`, [
        'bucket',
        'field'
      ]);
    }
  }
  const derived = new Set<string>();
  if (p.derive !== undefined) {
    if (!isObj(p.derive))
      fail('derive_invalid', 'derive maps names to { diff } or { ratio }', ['derive']);
    for (const [n, spec] of Object.entries(p.derive)) {
      const at = ['derive', n];
      if (!IDENT.test(n)) fail('derive_invalid', `derive name '${n}' must be an identifier`, at);
      const entries = isObj(spec) ? Object.entries(spec) : [];
      const [op, operands] = entries[0] ?? [];
      if (
        entries.length !== 1 ||
        (op !== 'diff' && op !== 'ratio') ||
        !Array.isArray(operands) ||
        operands.length !== 2
      ) {
        fail('derive_invalid', 'a derive is { diff: [a, b] } or { ratio: [a, b] }', at);
      }
      operands.forEach((o: unknown, i) => {
        deriveOperand(o, [...at, op, String(i)], scope, h);
      });
      derived.add(n);
    }
  }
  return derived;
}

/** `$.<number field>` of the seed row, or `_agg.<name>` of a number-valued frame aggregate. */
function deriveOperand(o: unknown, path: string[], scope: WalkScope, h: FrameHelpers): void {
  const m = typeof o === 'string' ? /^(\$|_agg)\.(.+)$/.exec(o) : null;
  let kind: string | undefined;
  if (m !== null) {
    const [, src, name] = m as unknown as [string, string, string];
    if (src === '_agg') kind = scope.aggs?.get(name);
    else {
      const def = h.lookup(scope.fields, name);
      kind = def === undefined ? undefined : h.kindOf(def);
    }
  }
  if (kind !== 'scalar.number') {
    fail(
      'derive_invalid',
      `derive operand '${String(o)}' must be a number field '$.<field>' or a number-valued '_agg.<name>' in this frame's fields`,
      path
    );
  }
}
