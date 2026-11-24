/**
 * Apply proposal helpers — runtime type + field registration.
 *
 * `applyTypeProposal` is the bridge between a stored TypeProposal (field specs
 * on the wire) and the live Registry: it parses each FieldSpecJson → FieldDef,
 * injects the engine-reserved shortId field (mirroring defineNamespace), and
 * delegates to `installAutoCrud` to register the full CRUD surface.
 *
 * `applyFieldProposal` extends an already-registered type with a new field by
 * replacing the type entry + all autoCRUD mutations with versions that include
 * the new field definition. The existing shortId field is preserved via spread.
 */

import { assertActionChains } from '@mnmal-ai/substrate-core';
import {
  type AutoCrudRegistry,
  assertIndexDecl,
  assertOrderedBy,
  assertTypeActions,
  autoCrudOptionsOf,
  type InstallAutoCrudOptions,
  installAutoCrud,
  RESERVED_AUTOCRUD_FIELDS
} from '@mnmal-ai/substrate-sdk';
import {
  type ActionDecl,
  type ActionSchema,
  canonicalize,
  type Dataset,
  type EdgesStore,
  type FieldDef,
  type IndexDecl,
  type OrderedBy,
  type Registry
} from '@mnmal-ai/substrate-types';
import { registryActions } from './action-layer.js';
import { appliedTargetCheck } from './cross-ref-targets.js';
import { ProposalError } from './errors.js';
import {
  assertCrossRefTargets,
  assertProposableName,
  assertValidFieldSpec,
  type CrossRefTargetCheck,
  type FieldSpecJson,
  parseFieldSpec
} from './field-spec-json.js';
import { PROPOSAL_TYPE_NAMES } from './namespace.js';
import { RESERVED, UNSAFE, WORD } from './propose-action-resolver.js';
import type { RegistryStore } from './registry-store.js';

// Engine-reserved fields (currently { shortId: ... }) come from substrate-sdk, not a
// local copy, so a reserved field added there propagates here.

export interface ApplyTypeProposalArgs {
  namespace: string;
  typeName: string;
  fields: Record<string, FieldSpecJson>;
  /** Actions born with the type, keyed by name. */
  actions?: Record<string, ActionDecl>;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
}

/**
 * Refuse a type proposal no caller could address, or whose crossRefs `targets`
 * refuses. The resolver passes a check that also requires an owned target type
 * to exist; replay cannot, as a target in another owned namespace may not have
 * been replayed yet.
 *
 * @throws ProposalError `invalid_params` / `invalid_field_spec`
 */
export function assertValidTypeProposal(
  typeName: unknown,
  fields: unknown,
  targets: CrossRefTargetCheck
): asserts fields is Record<string, FieldSpecJson> {
  assertProposableName('typeName', typeName);
  if (
    typeof fields !== 'object' ||
    fields === null ||
    Array.isArray(fields) ||
    Object.keys(fields).length === 0
  ) {
    throw new ProposalError('invalid_params', "'fields' must be a non-empty object", {
      param: 'fields'
    });
  }
  for (const [fieldName, spec] of Object.entries(fields as Record<string, FieldSpecJson>)) {
    assertValidFieldSpec(fieldName, spec);
    assertCrossRefTargets(fieldName, spec, targets);
  }
}

/** As `assertValidTypeProposal`, for one field on `targetType`. */
export function assertValidFieldProposal(
  targetType: unknown,
  fieldName: string,
  fieldSpec: FieldSpecJson,
  targets: CrossRefTargetCheck
): void {
  assertProposableName('targetType', targetType);
  if ((PROPOSAL_TYPE_NAMES as readonly string[]).includes(targetType)) {
    throw new ProposalError(
      'invalid_params',
      `'${targetType}' is a proposal type and cannot take proposed fields`,
      { param: 'targetType' }
    );
  }
  assertValidFieldSpec(fieldName, fieldSpec);
  assertCrossRefTargets(fieldName, fieldSpec, targets);
}

const DECL_KEYS: readonly string[] = ['kind', 'past', 'params', 'set', 'then'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Refuse actions born with a proposed type that code could not declare on it:
 * each named as an act word and well-formed against `fields`
 * (`assertTypeActions`), and every `then` chain from them as compose checks
 * it (`assertActionChains`) over `registryActions`, coined words left out,
 * plus these. An absent target in a namespace `awaited` admits is let
 * through: replay may not have reached it, and the compiler refuses a target
 * that never comes. The shape is checked first, as rows and params are raw
 * JSON.
 *
 * @throws ProposalError `invalid_params`
 */
export function assertValidTypeActions(
  namespace: string,
  typeName: string,
  fields: Record<string, FieldSpecJson>,
  actions: unknown,
  registryActions: ReadonlyMap<string, ActionSchema>,
  awaited: (ns: string) => boolean = () => false
): asserts actions is Record<string, ActionDecl> {
  const invalid = (message: string, param = 'actions') =>
    new ProposalError('invalid_params', message, { param });
  if (!isObject(actions)) throw invalid("'actions' must be an object");
  const fieldDefs = proposedFieldDefs(fields);
  const chains = new Map<string, ActionDecl>(
    [...registryActions].filter(([, action]) => action.coined !== true)
  );
  const keyOf = (name: string): string => `${namespace}/${typeName}.${name}`;
  const born = new Set(Object.keys(actions).map(keyOf));
  for (const [name, decl] of Object.entries(actions)) {
    const at = `actions.${name}`;
    if (!WORD.test(name) || RESERVED.has(name) || UNSAFE.has(name)) {
      throw invalid(`action name must match ${WORD.source}, and not be '${name}'`, at);
    }
    if (!isObject(decl) || Object.keys(decl).some((k) => !DECL_KEYS.includes(k))) {
      throw invalid(`action '${name}' must be an object of ${DECL_KEYS.join(', ')}`, at);
    }
    const { kind, past, params = {}, set = {}, then = [] } = decl;
    if (kind !== undefined && kind !== 'update' && kind !== 'create') {
      throw invalid("kind must be 'update' or 'create'", at);
    }
    if (past !== undefined && (typeof past !== 'string' || !WORD.test(past))) {
      throw invalid(`past must match ${WORD.source}`, at);
    }
    if (!isObject(params) || !isObject(set) || !Array.isArray(then)) {
      throw invalid('params and set must be objects, and then an array', at);
    }
    for (const [param, p] of Object.entries(params)) {
      if (UNSAFE.has(param) || !isObject(p)) throw invalid(`param '${param}' is not allowed`, at);
    }
    for (const [f, v] of Object.entries(set)) {
      if (!Object.hasOwn(fieldDefs, f)) throw invalid(`'${f}' is not a field of ${typeName}`, at);
      if (isObject(v) && 'param' in v && !Object.hasOwn(params, String(v.param))) {
        throw invalid(`set uses undeclared param '${String(v.param)}'`, at);
      }
    }
    const kept: unknown[] = [];
    for (const t of then) {
      if (!isObject(t) || typeof t.action !== 'string' || !isObject(t.each)) {
        throw invalid('a then entry needs an action and each', at);
      }
      const slash = t.action.indexOf('/');
      if (chains.has(t.action) || born.has(t.action)) kept.push(t);
      else if (slash <= 0 || !awaited(t.action.slice(0, slash))) {
        throw invalid(`then target ${t.action} is not declared in code or born with a type`, at);
      }
    }
    // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
    chains.set(keyOf(name), { ...decl, then: kept } as ActionDecl);
  }
  try {
    assertTypeActions(typeName, {
      fields: fieldDefs,
      actions: actions as Record<string, ActionDecl>
    });
    assertActionChains(chains, born);
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : String(err));
  }
}

/** Installs the proposed type's autoCRUD surface into `registry`. */
function installProposedType(
  registry: AutoCrudRegistry,
  args: Pick<ApplyTypeProposalArgs, 'typeName' | 'fields' | 'actions' | 'dataset' | 'edges'>
): void {
  installAutoCrud(registry, args.typeName, args.dataset, args.edges, {
    fields: proposedFieldDefs(args.fields),
    ...(args.actions !== undefined ? { actions: args.actions } : {})
  });
}

/** A proposed type's field specs as FieldDefs, with the engine-reserved fields added. */
export function proposedFieldDefs(fields: Record<string, FieldSpecJson>): Record<string, FieldDef> {
  const fieldDefs: Record<string, FieldDef> = {};
  for (const [name, spec] of Object.entries(fields)) {
    fieldDefs[name] = parseFieldSpec(spec);
  }
  return Object.assign(fieldDefs, RESERVED_AUTOCRUD_FIELDS);
}

/**
 * Every registry key `applyTypeProposal` would register for this proposal —
 * the type name plus each autoCRUD operation name — without registering any.
 *
 * @returns the keys in registration order
 * @throws whatever `applyTypeProposal` would throw for an invalid field spec
 */
export function typeProposalRegistryKeys(
  args: Pick<ApplyTypeProposalArgs, 'typeName' | 'fields' | 'dataset' | 'edges'>
): string[] {
  const keys: string[] = [];
  installProposedType({ register: (key) => keys.push(key) }, args);
  return keys;
}

/**
 * Validates, then installs. Every path that turns a row into schema (the
 * resolver, boot replay, a peer's NOTIFY) passes through here, and a row can
 * be written directly by any holder of the propose capability.
 */
export function applyTypeProposal(args: ApplyTypeProposalArgs): void {
  const store = args.registryStore;
  assertValidTypeProposal(args.typeName, args.fields, appliedTargetCheck(store, args.namespace));
  const binding = store.getBinding(args.namespace);
  if (args.actions !== undefined) {
    // Another owned namespace's types may not be replayed yet.
    assertValidTypeActions(
      args.namespace,
      args.typeName,
      args.fields,
      args.actions,
      registryActions(binding.engine?.federatedSchema() ?? {}),
      (ns) => ns !== args.namespace && store.ownsNamespace(ns)
    );
  }

  // Installing registers one key at a time, so a taken operation key must be
  // found first or the type entry registered before it stays behind. A taken
  // type name fails on the first register, with nothing to leave.
  const taken = typeProposalRegistryKeys(args).find(
    (key) => key !== args.typeName && binding.registry.has(key)
  );
  if (taken !== undefined) {
    throw new ProposalError(
      'type_already_exists',
      `Type '${args.typeName}' would register '${taken}', which is already registered in namespace '${args.namespace}'`
    );
  }

  installProposedType(binding.registry, args);

  // Drop the engine's cached schema views so federatedSchema() and
  // schemaFor(ns) reflect the new type immediately. Unset before onStart,
  // when no engine (and so no cache) exists.
  binding.invalidateSchemaCaches?.();
}

export interface ApplyFieldProposalArgs {
  namespace: string;
  targetType: string;
  fieldName: string;
  fieldSpec: FieldSpecJson;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
}

/** A proposed type's indexes, natural order and size hint, as its TypeProposal row stores them. */
export interface TypeIndexOptions {
  indexes?: IndexDecl[];
  orderedBy?: OrderedBy;
  expectedSize?: 'small' | 'large';
}

/**
 * Parses a TypeProposal row's `indexesJson` / `orderedByJson` / `expectedSize`
 * (null or absent: none). An `expectedSize` other than `small` or `large` is
 * left out and handed to `onInvalidSize`, so a bad hint never costs the type
 * its indexes or order.
 */
export function typeIndexOptionsOf(
  row: Record<string, unknown>,
  onInvalidSize?: (err: Error) => void
): TypeIndexOptions {
  const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : undefined);
  const indexes = parse(row.indexesJson) as IndexDecl[] | undefined;
  const orderedBy = parse(row.orderedByJson) as OrderedBy | undefined;
  const size = row.expectedSize ?? undefined;
  const expectedSize = size === 'small' || size === 'large' ? size : undefined;
  if (size !== undefined && expectedSize === undefined) {
    onInvalidSize?.(
      new Error(
        `expectedSize on ${String(row.typeName)} must be 'small' or 'large', got '${String(size)}'; ignored`
      )
    );
  }
  return {
    ...(indexes !== undefined ? { indexes } : {}),
    ...(orderedBy !== undefined ? { orderedBy } : {}),
    ...(expectedSize !== undefined ? { expectedSize } : {})
  };
}

/**
 * Refuse indexes or a natural order `propose_index` would not accept: each
 * index as code may declare it, but never unique and never named (a name
 * adopts whatever index already holds it), so every one is the engine's own,
 * non-unique and generated. Rows are caller-written, so replay checks too.
 *
 * @throws Error naming the first problem
 */
export function assertValidTypeIndexOptions(
  typeName: string,
  fields: Record<string, FieldDef>,
  opts: TypeIndexOptions
): void {
  if (opts.indexes !== undefined && !Array.isArray(opts.indexes)) {
    throw new Error(`indexes on ${typeName} must be an array`);
  }
  for (const decl of opts.indexes ?? []) {
    if (typeof decl !== 'object' || decl === null) {
      throw new Error(`index on ${typeName}: must be an object`);
    }
    assertIndexDecl(typeName, fields, decl);
    if (decl.unique !== undefined) {
      throw new Error(`index on ${typeName}: a proposed index is never unique`);
    }
    if (decl.name !== undefined) {
      throw new Error(`index on ${typeName}: a proposed index takes a generated name`);
    }
  }
  if (opts.orderedBy !== undefined)
    assertOrderedBy(typeName, { fields, orderedBy: opts.orderedBy });
  if (
    opts.expectedSize !== undefined &&
    opts.expectedSize !== 'small' &&
    opts.expectedSize !== 'large'
  ) {
    throw new Error(`expectedSize on ${typeName} must be 'small' or 'large'`);
  }
}

/**
 * Reinstall `typeName`'s autoCRUD surface with `patch` over the options it was
 * installed with (policy, postWrite, purge, indexes, order), swapping every
 * entry through `registry.replace` so DuplicateRegistration is never thrown.
 */
function reinstallType(
  registry: Registry,
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  patch: (prior: InstallAutoCrudOptions) => InstallAutoCrudOptions
): void {
  const existing = registry.get(typeName);
  if (!existing) throw new Error(`type '${typeName}' not registered`);
  // A mutation shares the registry with types; reinstalling over one would
  // replace it with a type entry.
  if (existing.kind !== 'type') throw new Error(`'${typeName}' is not a type`);
  const replaceWriter = {
    register: (
      key: Parameters<typeof registry.replace>[0],
      input: Parameters<typeof registry.replace>[1]
    ) => registry.replace(key, input),
    replace: registry.replace.bind(registry),
    // Read back by the reinstalled updateMany/deleteMany, which are served
    // only while update<T>/delete<T> are autoCRUD's own entries.
    get: registry.get.bind(registry)
  };
  const prior = autoCrudOptionsOf(existing.resolver) ?? {
    policy: existing.policy,
    fields: existing.fields
  };
  installAutoCrud(replaceWriter, typeName, dataset, edges, patch(prior));
}

export interface ApplyTypeIndexOptionsArgs extends TypeIndexOptions {
  namespace: string;
  typeName: string;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
}

/**
 * Give a registered proposed type the indexes and natural order its row
 * stores, validated against the fields it has now (proposed ones included).
 * Storage builds them on the next `ensureTypeStorage`.
 */
export function applyTypeIndexOptions(args: ApplyTypeIndexOptionsArgs): void {
  const binding = args.registryStore.getBinding(args.namespace);
  const existing = binding.registry.get(args.typeName);
  if (!existing) throw new Error(`type '${args.typeName}' not registered`);
  assertValidTypeIndexOptions(args.typeName, existing.fields, args);
  reinstallType(binding.registry, args.typeName, args.dataset, args.edges, (prior) => {
    const { indexes: _i, orderedBy: _o, expectedSize: _s, ...rest } = prior;
    return {
      ...rest,
      ...(args.indexes !== undefined ? { indexes: args.indexes } : {}),
      ...(args.orderedBy !== undefined ? { orderedBy: args.orderedBy } : {}),
      ...(args.expectedSize !== undefined ? { expectedSize: args.expectedSize } : {})
    };
  });
  binding.invalidateSchemaCaches?.();
}

/** Whether the type entry already carries exactly these options. */
export function hasTypeIndexOptions(entry: TypeIndexOptions, opts: TypeIndexOptions): boolean {
  return (
    sameJson(entry.indexes, opts.indexes) &&
    sameJson(entry.orderedBy, opts.orderedBy) &&
    entry.expectedSize === opts.expectedSize
  );
}

/** Deep equality of JSON values, whatever order their keys were written in. */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * Extend an already-registered type with a new field.
 *
 * Replaces the type entry + all autoCRUD mutations atomically with versions
 * that include the new field. Uses a `replaceWriter` that funnels every
 * `register` call from installAutoCrud through `registry.replace()` so
 * DuplicateRegistration is never thrown.
 *
 * The replacement is strictly additive — existing rows without the new field
 * continue to read as field-absent.
 */
export function applyFieldProposal(args: ApplyFieldProposalArgs): void {
  const store = args.registryStore;
  assertValidFieldProposal(
    args.targetType,
    args.fieldName,
    args.fieldSpec,
    appliedTargetCheck(store, args.namespace)
  );
  const binding = store.getBinding(args.namespace);
  const existing = binding.registry.get(args.targetType);
  if (!existing) {
    throw new Error(`applyFieldProposal: target type '${args.targetType}' not registered`);
  }
  const nextFields: Record<string, FieldDef> = {
    ...existing.fields,
    [args.fieldName]: parseFieldSpec(args.fieldSpec)
  };
  // Keep what the type was installed with (policy, postWrite, purge, indexes); only the fields change.
  reinstallType(binding.registry, args.targetType, args.dataset, args.edges, (prior) => ({
    ...prior,
    fields: nextFields
  }));

  // Drop the engine's cached schema views so federatedSchema() and
  // schemaFor(ns) reflect the new field immediately.
  binding.invalidateSchemaCaches?.();
}
