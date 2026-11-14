/**
 * Typed edge walk validation (spec 2026-10-24-typed-edge-walks §1, §2).
 *
 * Checks `_walk` nodes, `_agg` aggregates (where-side and in `fields`),
 * nested `{ _walk }` selections, `$ref` operands, and the frame params
 * `count`, `aggregate`, `groupBy` and `select`. The recursion into a walk's far-side `where` is handed back to the
 * filter validator, so the far type's fields and operators are checked exactly
 * as a top-level read of that type would be.
 */

import {
  checkExpr,
  type ExprScope,
  exprTypeOfField,
  metadataExprType
} from '@mnmal-ai/substrate-filter';
import {
  EXPR_LIMITS,
  type Expr,
  type ExprType,
  type FieldDef,
  type FieldKind,
  type TypeSchema,
  type WalkNode
} from '@mnmal-ai/substrate-types';
import { walkGrammarPath } from '../walk-gate.js';
import { FilterValidationError } from './validator.js';

export const MAX_WALK_DEPTH = 3;
/** Joint quantification enumerates the product of the bound walks' neighbourhoods, so cap the factors. */
export const MAX_GROUP_BINDINGS = 3;
export const MAX_FRAME_BINDINGS = 6;
// ~317 years: a date from 4396 BC to 275443 AD shifts inside pg timestamptz (from 4713 BC) and JS Date (±8.64e15 ms).
export const MAX_DATE_SHIFT_MS = 1e13;

const COMPARISON_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const WALK_KEYS = new Set(['as', 'in', 'out', 'where', 'quantifier', 'pick', 'among']);

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
  /** Expression nodes checked so far in this frame, shared by every scope derived from the seed. */
  exprNodes?: { count: number };
  /** Expressions see only `fields`, not the row metadata names (a `having` sees the frame's outputs only). */
  outputsOnly?: boolean;
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
  if (node.among !== undefined) {
    if (pick === undefined) {
      fail(
        'walk_quantifier',
        "'among' narrows the rows a pick chooses from; without a pick use 'where'",
        [...path, 'among']
      );
    }
    validateWhere(node.among, [...path, 'among'], farScope(scope, hop));
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
  if (
    fieldKind === 'scalar.date' &&
    typeof operand.plus === 'number' &&
    Math.abs(operand.plus) > MAX_DATE_SHIFT_MS
  ) {
    fail(
      'type_mismatch',
      `a date $ref shifts by at most ${MAX_DATE_SHIFT_MS} ms either way, got ${operand.plus}`,
      [...path, 'plus']
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

/**
 * One aggregate function over `owner`'s fields, returning its value kind:
 * `count`, `avg` and `sum` are numbers; `min`, `max` and `latest` take their
 * field's kind. `latest` picks a row: it belongs to a per-row walk aggregate.
 */
function aggKind(
  agg: Record<string, unknown>,
  owner: Hop,
  path: string[],
  h: FrameHelpers
): string {
  for (const k of Object.keys(agg)) {
    if (!WALK_AGG_KEYS.has(k) && !AGG_FNS.has(k)) {
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
  const kind = aggKind(agg, hop, path, h);
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
      // As `aggregate: {}` is (Ruling 35): an empty one is not a walk read on pg.
      if (Object.keys(sel).length === 0) fail('agg_invalid', '_agg needs at least one entry', at);
      // One _agg cannot reference another: validated with no _agg names in scope.
      const own = { ...scope, aggs: new Map<string, string>() };
      for (const [n, agg] of Object.entries(sel)) {
        if (!IDENT.test(n)) {
          fail('agg_invalid', `aggregate name '${n}' must be an identifier`, [...at, n]);
        }
        aggs.set(n, validateWalkAgg(agg, [...at, n], own, h));
      }
    } else if (isObj(sel) && Object.hasOwn(sel, '_walk')) {
      // The nested list lands under its name in the row, and the wire plans
      // a declared name as that field, so the name must be free.
      if (Object.hasOwn(scope.fields, name)) {
        fail(
          'walk_unsupported_ref',
          `a nested selection cannot reuse the declared field name '${name}'; name it something else`,
          at
        );
      }
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

/** Row keys a read projects besides the type's fields, which a select value must not overwrite. */
const RESERVED_ROW_KEYS = new Set([
  'id',
  'shortId',
  '_metadata',
  '_deletedAt',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'createdById',
  'createdByKind',
  'updatedById',
  'updatedByKind',
  'seq'
]);

/** The expression type of a walk aggregate's value kind; a boolean or int64 value is not usable. */
const AGG_EXPR_TYPE: Partial<Record<string, ExprType>> = {
  'scalar.number': 'number',
  'scalar.date': 'date',
  'scalar.string': 'string'
};

function exprScopeOf(scope: WalkScope, withAgg: boolean): ExprScope {
  return {
    field(name) {
      if (name.startsWith('_agg.')) {
        const kind = withAgg ? scope.aggs?.get(name.slice(5)) : undefined;
        return kind === undefined ? undefined : AGG_EXPR_TYPE[kind];
      }
      return (
        (scope.outputsOnly ? undefined : metadataExprType(name)) ??
        (Object.hasOwn(scope.fields, name) ? exprTypeOfField(scope.fields[name]) : undefined)
      );
    }
  };
}

/** Refuses a bare `_agg.<name>` whose value type (boolean, int64, ...) no expression can use. */
function refuseUnusableAgg(expr: unknown, scope: WalkScope, path: string[], depth = 0): void {
  // Each expression level is an object and its argument array; checkExpr refuses anything deeper.
  if (depth > 2 * EXPR_LIMITS.maxDepth + 2) return;
  if (typeof expr === 'string') {
    const kind = expr.startsWith('_agg.') ? scope.aggs?.get(expr.slice(5)) : undefined;
    if (kind !== undefined && AGG_EXPR_TYPE[kind] === undefined) {
      fail(
        'expr_invalid',
        `'${expr}' has a ${kind.replace('scalar.', '')} value, which an expression cannot use (only number, date and string aggregates)`,
        path
      );
    }
  } else if (Array.isArray(expr)) {
    for (const e of expr) refuseUnusableAgg(e, scope, path, depth + 1);
  } else if (isObj(expr)) {
    for (const [k, v] of Object.entries(expr))
      if (k !== 'lit' && k !== 'int64') refuseUnusableAgg(v, scope, path, depth + 1);
  }
}

/** Checks one expression of the frame, charging its nodes to the frame's budget; returns its type. */
export function checkFrameExpr(
  expr: unknown,
  scope: WalkScope,
  withAgg: boolean,
  path: string[]
): ExprType {
  if (withAgg) refuseUnusableAgg(expr, scope, path);
  const r = checkExpr(expr as Expr, exprScopeOf(scope, withAgg), path);
  if (!r.ok) fail('expr_invalid', r.message, r.path);
  const used = scope.exprNodes ?? { count: 0 };
  used.count += r.nodes;
  if (used.count > EXPR_LIMITS.maxNodesPerFrame) {
    fail(
      'expr_invalid',
      `the frame's expressions have more than maxNodesPerFrame (${EXPR_LIMITS.maxNodesPerFrame}) nodes`,
      path
    );
  }
  return r.type;
}

export interface FrameParams {
  select?: unknown;
  count?: unknown;
  aggregate?: unknown;
  groupBy?: unknown;
  having?: unknown;
  offset?: unknown;
  cursor?: unknown;
  orderBy?: unknown;
  fields?: Record<string, unknown>;
}

/**
 * `count`, `aggregate`, `groupBy` and `select`, and what each excludes.
 * Returns the names `orderBy` may use: select names and group outputs.
 */
export function validateFrameParams(
  p: FrameParams,
  scope: WalkScope,
  h: FrameHelpers
): { selected: ReadonlySet<string> } {
  if (p.count !== undefined && typeof p.count !== 'boolean') {
    fail('type_mismatch', 'count takes true or false', ['count']);
  }
  if (p.count === true) {
    for (const k of ['aggregate', 'select', 'orderBy', 'cursor'] as const) {
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
  const outputs = new Map<string, ExprType>();
  const grouped = p.aggregate !== undefined;
  for (const k of ['groupBy', 'having', 'offset'] as const) {
    if (p[k] !== undefined && !grouped) {
      fail('agg_invalid', `${k} shapes an aggregate's groups; it needs aggregate`, [k]);
    }
  }
  if (p.aggregate !== undefined) {
    // `limit` stays: it caps the groups. orderBy takes the group outputs.
    const refused =
      p.groupBy !== undefined ? ['select', 'cursor'] : ['select', 'orderBy', 'cursor'];
    for (const k of refused as Array<'select' | 'orderBy' | 'cursor'>) {
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
    if (!isObj(p.aggregate))
      fail('agg_invalid', 'aggregate maps names to aggregates', ['aggregate']);
    if (Object.keys(p.aggregate).length === 0) {
      fail('agg_invalid', 'aggregate needs at least one entry', ['aggregate']);
    }
    for (const [n, agg] of Object.entries(p.aggregate)) {
      const at = ['aggregate', n];
      if (!IDENT.test(n)) fail('agg_invalid', `aggregate name '${n}' must be an identifier`, at);
      if (!isObj(agg)) fail('agg_invalid', 'an aggregate is an object such as { count: true }', at);
      outputs.set(n, frameAggType(agg, scope, at));
    }
  }
  if (p.groupBy !== undefined) {
    if (!isObj(p.groupBy) || Object.keys(p.groupBy).length === 0) {
      fail('group_invalid', 'groupBy maps names to expressions, and needs at least one', [
        'groupBy'
      ]);
    }
    for (const [n, expr] of Object.entries(p.groupBy)) {
      const at = ['groupBy', n];
      if (!IDENT.test(n)) fail('group_invalid', `groupBy name '${n}' must be an identifier`, at);
      if (outputs.has(n)) {
        fail('group_invalid', `groupBy name '${n}' is also an aggregate name`, at);
      }
      outputs.set(n, checkFrameExpr(expr, scope, false, at));
    }
  }
  if (p.having !== undefined) {
    const named: WalkScope = {
      ...scope,
      outputsOnly: true,
      fields: Object.fromEntries(
        [...outputs].map(([n, t]) => [n, { kind: 'scalar', type: t } as FieldDef])
      )
    };
    const t = checkFrameExpr(p.having, named, false, ['having']);
    if (t !== 'boolean') fail('expr_invalid', `having must be boolean, got ${t}`, ['having']);
  }
  if (p.offset !== undefined && (!Number.isSafeInteger(p.offset) || (p.offset as number) < 0)) {
    fail('type_mismatch', 'offset takes a non-negative integer', ['offset']);
  }
  if (p.groupBy !== undefined && Array.isArray(p.orderBy)) {
    p.orderBy.forEach((c, i) => {
      const k = isObj(c) ? Object.keys(c)[0] : undefined;
      if (k !== undefined && !outputs.has(k)) {
        fail('agg_invalid', `orderBy '${k}' names no groupBy or aggregate output`, [
          'orderBy',
          String(i),
          k
        ]);
      }
    });
  }
  const selected = new Set<string>();
  if (p.select !== undefined) {
    if (!isObj(p.select)) fail('select_invalid', 'select maps names to expressions', ['select']);
    for (const [n, expr] of Object.entries(p.select)) {
      const at = ['select', n];
      if (!IDENT.test(n)) fail('select_invalid', `select name '${n}' must be an identifier`, at);
      const nested = p.fields?.[n];
      if (
        h.lookup(scope.fields, n) !== undefined ||
        RESERVED_ROW_KEYS.has(n) ||
        (isObj(nested) && '_walk' in nested)
      ) {
        fail(
          'select_invalid',
          `select name '${n}' collides with a field, a row key or a nested selection of the type`,
          at
        );
      }
      checkFrameExpr(expr, scope, true, at);
      selected.add(n);
    }
  }
  return { selected: new Set([...selected, ...outputs.keys()]) };
}

const FRAME_AGG_FNS = ['count', 'countDistinct', 'avg', 'sum', 'min', 'max'];

/** A frame aggregate: one function over an expression (`count: true` counts rows). Returns its value type. */
function frameAggType(agg: Record<string, unknown>, scope: WalkScope, path: string[]): ExprType {
  for (const k of Object.keys(agg)) {
    if (k === 'latest') {
      fail(
        'agg_invalid',
        'latest picks one row per seed row; a frame aggregate takes count, countDistinct, avg, sum, min or max',
        [...path, k]
      );
    }
    if (!FRAME_AGG_FNS.includes(k))
      fail('agg_invalid', `unknown aggregate key '${k}'`, [...path, k]);
  }
  if (Object.keys(agg).length !== 1) {
    fail(
      'agg_invalid',
      'an aggregate names exactly one of count, countDistinct, avg, sum, min or max',
      path
    );
  }
  const [fn] = Object.keys(agg) as [string];
  const at = [...path, fn];
  if (fn === 'count' && agg.count === true) return 'number';
  const arg = agg[fn];
  if (
    fn === 'count' &&
    (arg === null ||
      typeof arg === 'number' ||
      typeof arg === 'boolean' ||
      (isObj(arg) && ('lit' in arg || 'int64' in arg)))
  ) {
    fail('agg_invalid', 'count takes true (rows) or an expression, not another literal', at);
  }
  const t = checkFrameExpr(arg, scope, false, at);
  const ok: Record<string, ExprType[]> = {
    avg: ['number', 'int64'],
    sum: ['number', 'int64'],
    min: ['number', 'int64', 'string', 'date'],
    max: ['number', 'int64', 'string', 'date']
  };
  if (ok[fn] !== undefined && !ok[fn].includes(t)) {
    fail('agg_invalid', `${fn} needs ${ok[fn].join(', ')}; the argument is ${t}`, at);
  }
  return fn === 'count' || fn === 'countDistinct' || fn === 'avg' ? 'number' : t;
}
