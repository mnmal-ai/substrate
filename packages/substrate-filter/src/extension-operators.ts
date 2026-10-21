/**
 * Extension-operator registry. Spec: §5.2.
 *
 * Substrate plugins (e.g. substrate-recall's `embeddingSimilar`) register custom
 * where-clause operators here at compose-time. The registry is module-scope
 * state shared between:
 *   - substrate-core's filter validator (accepts the operator key during
 *     where-clause validation)
 *   - substrate-dataset-pg's pre-resolver (dispatches op.execute(...) before SQL
 *     translation, substitutes the result into an `id IN (...)` clause)
 *
 * Tests should call `clearExtensionOperators()` in afterEach to prevent
 * cross-test leakage.
 *
 * The backing Maps hang off `globalThis` under `Symbol.for` keys because a
 * process can hold more than one copy of this package (a plugin resolving its
 * own `substrate-filter`); module-scope Maps would split the registry, and an
 * operator registered through one copy would be silently unknown to the other.
 *
 * The keys carry `.v1` so two copies with incompatible `FilterOperatorDef`
 * shapes fall back to separate registries rather than reading each other's
 * entries. Bump the suffix when `FilterOperatorDef` changes shape.
 */

import {
  type FilterOperatorDef,
  METADATA_AUTHOR_FIELDS,
  METADATA_FILTER_FIELDS
} from '@mnmal-ai/substrate-types';

const REGISTRY_KEY: unique symbol = Symbol.for('substrate.filter.extensionOperators.v1');
const OWNERS_KEY: unique symbol = Symbol.for('substrate.filter.computedFieldOwners.v1');

interface RegistryHost {
  [REGISTRY_KEY]?: Map<string, FilterOperatorDef>;
  [OWNERS_KEY]?: Map<string, string>;
}

const host = globalThis as typeof globalThis & RegistryHost;

const extensionOperators: Map<string, FilterOperatorDef> =
  host[REGISTRY_KEY] ?? new Map<string, FilterOperatorDef>();
host[REGISTRY_KEY] = extensionOperators;

/**
 * computedField → owning operator name. An operator may declare
 * `computedFields` (e.g. embeddingSimilar owns `_score` + `_vector`): fields
 * that only exist on a row when the operator runs. The engine's computed-field
 * gate reads this map to refuse projecting a computed field without its operator in
 * the where-clause.
 */
const computedFieldOwners: Map<string, string> = host[OWNERS_KEY] ?? new Map<string, string>();
host[OWNERS_KEY] = computedFieldOwners;

/** Where-clause keys the grammar already owns: combinators, ids and row metadata. */
function isReservedName(name: string): boolean {
  return (
    ['AND', 'OR', 'NOT', 'shortId', '_metadata'].includes(name) ||
    Object.hasOwn(METADATA_FILTER_FIELDS, name) ||
    Object.hasOwn(METADATA_AUTHOR_FIELDS, name)
  );
}

/**
 * Register a custom where-clause operator under `name`. Throws if `name` is a
 * reserved where-clause key or already registered, or if any of its
 * `computedFields` is already claimed by another operator. `name` comes from the Record key in
 * `KernelPlugin.filterOperators`.
 *
 * Computed-field collisions throw rather than overwrite: silently overwriting
 * ownership would make the computed-field gate name the wrong operator.
 */
export function registerExtensionOperator(name: string, op: FilterOperatorDef): void {
  if (isReservedName(name)) {
    throw new Error(`Filter operator name '${name}' is reserved by the where-clause grammar`);
  }
  if (extensionOperators.has(name)) {
    throw new Error(`Filter operator '${name}' already registered`);
  }
  for (const cf of op.computedFields ?? []) {
    const existing = computedFieldOwners.get(cf);
    if (existing !== undefined) {
      throw new Error(
        `Computed field '${cf}' is already owned by operator '${existing}'; '${name}' cannot also claim it`
      );
    }
  }
  extensionOperators.set(name, op);
  for (const cf of op.computedFields ?? []) {
    computedFieldOwners.set(cf, name);
  }
}

/**
 * The operator name owning a computed projection field, or undefined when no
 * registered operator claims it. Used by the engine's computed-field gate to refuse
 * projecting a computed field without its operator present in where.
 */
export function computedFieldOwner(field: string): string | undefined {
  return computedFieldOwners.get(field);
}

/**
 * True when any registered operator declares computed fields. Common-case
 * fast-path for the engine's computed-field gate (no semantic operator composed → skip
 * the per-frame fields walk entirely); the per-field `computedFieldOwner`
 * check remains authoritative.
 */
export function hasComputedFields(): boolean {
  return computedFieldOwners.size > 0;
}

/** Look up a registered extension operator by name. Returns undefined when absent. */
export function getExtensionOperator(name: string): FilterOperatorDef | undefined {
  return extensionOperators.get(name);
}

/**
 * Sorted list of registered extension-operator names. Surfaced by
 * `/substrate/v1/onboard` so HTTP consumers can branch on "is `embeddingSimilar`
 * composed?" without sniffing error strings from a failed query.
 */
export function listExtensionOperators(): ReadonlyArray<string> {
  return Array.from(extensionOperators.keys()).sort();
}

/** Clear all registered extension operators. Intended for test isolation. */
export function clearExtensionOperators(): void {
  extensionOperators.clear();
  computedFieldOwners.clear();
}

/**
 * True when any key in the where-tree (root, nested under AND/OR/NOT, or
 * inside a struct-field sub-clause) is a registered extension operator.
 * Used by the subscribe path to refuse semantic filters at registration —
 * extension operators have no incremental evaluation, so a subscription
 * carrying one would silently degrade. Leaf predicate objects ({ eq: 'x' }) recurse harmlessly: their
 * keys are not registered operators and their values are not objects.
 */
export function whereContainsExtensionOperator(where: unknown): boolean {
  if (Array.isArray(where)) return where.some((w) => whereContainsExtensionOperator(w));
  if (where === null || typeof where !== 'object') return false;
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'AND' || key === 'OR') {
      if (Array.isArray(value) && value.some((w) => whereContainsExtensionOperator(w))) return true;
      continue;
    }
    if (key === 'NOT') {
      if (whereContainsExtensionOperator(value)) return true;
      continue;
    }
    if (getExtensionOperator(key) !== undefined) return true;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (whereContainsExtensionOperator(value)) return true;
    }
  }
  return false;
}

/**
 * True when the where-tree contains a key equal to `opName` in operator
 * position (root, AND/OR/NOT combinator, struct-field sub-clause, or array
 * element). The named variant of `whereContainsExtensionOperator`: the
 * computed-field gate needs the operator that OWNS the projected field present,
 * not merely SOME registered operator. Same structural walk; matches by name
 * rather than registry membership.
 */
export function whereContainsOperator(where: unknown, opName: string): boolean {
  if (Array.isArray(where)) return where.some((w) => whereContainsOperator(w, opName));
  if (where === null || typeof where !== 'object') return false;
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'AND' || key === 'OR') {
      if (Array.isArray(value) && value.some((w) => whereContainsOperator(w, opName))) return true;
      continue;
    }
    if (key === 'NOT') {
      if (whereContainsOperator(value, opName)) return true;
      continue;
    }
    if (key === opName) return true;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (whereContainsOperator(value, opName)) return true;
    }
  }
  return false;
}
