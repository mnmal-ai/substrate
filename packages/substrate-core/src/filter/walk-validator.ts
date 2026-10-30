/**
 * Typed edge walk validation (spec 2026-10-24-typed-edge-walks §1, §2).
 *
 * Checks `_walk` nodes, the walk part of a where-side `_agg`, and `$ref`
 * operands. The recursion into a walk's far-side `where` is handed back to the
 * filter validator, so the far type's fields and operators are checked exactly
 * as a top-level read of that type would be.
 */

import type { FieldDef, FieldKind, TypeSchema, WalkNode } from '@mnmal-ai/substrate-types';
import { FilterValidationError } from './validator.js';

export const MAX_WALK_DEPTH = 3;

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
}

export type FieldLookup = (fields: Record<string, FieldDef>, name: string) => FieldDef | undefined;

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
  if (typeof node.as !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(node.as)) {
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
  if (pick !== undefined) {
    const entries = isObj(pick) ? Object.entries(pick) : [];
    const [k, field] = entries[0] ?? [];
    if (entries.length !== 1 || (k !== 'latest' && k !== 'max' && k !== 'min')) {
      fail('type_mismatch', 'pick is one of { latest }, { max } or { min }', [...path, 'pick']);
    }
    const def =
      typeof field === 'string' && Object.hasOwn(hop.fields, field) ? hop.fields[field] : undefined;
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
  const ref = operand.$ref;
  const m = typeof ref === 'string' ? /^([^.]+)\.(.+)$/.exec(ref) : null;
  if (m === null)
    fail(
      'ref_unresolved',
      `$ref must be '$.<field>' or '<as>.<field>', got '${String(ref)}'`,
      path
    );
  const [, name, field] = m as unknown as [string, string, string];
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
