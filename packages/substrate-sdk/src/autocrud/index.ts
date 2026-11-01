/**
 * @mnmal-ai/substrate-sdk/autocrud — default resolvers for registered types.
 * Spec: §5.1.
 *
 * Naming convention: `installAutoCrud(registry, 'Todo', dataset, edges)`
 * registers
 *   - type entry: `Todo` (the list resolver, engine.query({ Todo: ... }))
 *   - mutation: `getTodo` (single read by id)
 *   - mutation: `createTodo` (edge-aware when the type has crossRef fields)
 *   - mutation: `updateTodo` (id-based multi-field update, one `write()`
 *     inside the engine's G1 transaction)
 *   - mutation: `deleteTodo` (two-phase delete, §6.2)
 *   - mutation: `updateManyTodo` (`{ where, set }`) and `deleteManyTodo`
 *     (`{ where }`), by filter (`./filter-writes.ts`)
 *
 * `registry` is typed structurally via `AutoCrudRegistry` so this package takes
 * no runtime dependency on `@mnmal-ai/substrate-core`; the core `Registry`
 * satisfies the interface shape.
 */

import { and, requireCapability } from '@mnmal-ai/substrate-policy';
import type {
  AutoCrudVerb,
  BatchResolver,
  Dataset,
  EdgesStore,
  FieldDef,
  FieldDefStruct,
  IndexDecl,
  OrderedBy,
  Policy,
  ReadResult,
  RequestContext,
  ResolverArgs,
  Row,
  TypedResolver
} from '@mnmal-ai/substrate-types';
import type { PostWriteHook } from '../namespace.js';
import { getResolver } from './autocrud-get.js';
import { listResolver } from './autocrud-list.js';
import { purgeResolver } from './autocrud-purge.js';
import {
  createBatchResolver,
  deleteBatchResolver,
  singleFrame,
  updateBatchResolver
} from './batch.js';
import { deleteManyResolver, updateManyResolver } from './filter-writes.js';
import {
  assertCrossRefDeletePolicies,
  assertServerSetFieldsFillable,
  assertVocabImplications
} from './internal.js';

export { getResolver } from './autocrud-get.js';
export { listResolver } from './autocrud-list.js';
export { purgeResolver } from './autocrud-purge.js';
export type { UpdateResolverOptions } from './autocrud-update.js';
export { applyUpdatePatch } from './autocrud-update.js';
export { createResolver, deleteResolver, updateResolver } from './batch.js';
export type { FilterWriteMutationResult } from './filter-writes.js';
export { deleteManyResolver, updateManyResolver } from './filter-writes.js';

/**
 * The narrow surface `installAutoCrud` needs from a registry. The core
 * `Registry` class satisfies this structurally.
 *
 * Resolver signature matches the core `Resolver` type exactly — typed against
 * `(ctx, args) => Promise<Row | Row[] | null>` so autocrud's `get` can surface
 * null without sentinel gymnastics.
 */
export type AutoCrudResolver = (
  ctx: RequestContext,
  args: ResolverArgs
) => Promise<Row | Row[] | ReadResult | null>;

export interface AutoCrudRegistry {
  register(
    typeName: string,
    input: {
      resolver: AutoCrudResolver;
      /** Set-wise resolver for a mutate array of this mutation. */
      batch?: BatchResolver;
      policy?: Policy;
      fields?: Record<string, FieldDef>;
      kind?: 'type' | 'mutation';
      params?: Record<string, FieldDef>;
      returns?: FieldDef;
      orderedBy?: OrderedBy;
      indexes?: IndexDecl[];
      expectedSize?: 'small' | 'large';
      /** Semantic autoCRUD verb threaded to policies via ctx.verb. */
      verb?: AutoCrudVerb;
      /** The type a by-filter mutation writes; the engine validates its `where`. */
      filterTarget?: string;
    }
  ): void;
  /** When present, lets `installAutoCrud` refuse a type whose keys collide with another's. */
  get?(typeName: string): { kind?: string; resolver: object } | undefined;
}

/**
 * A namespace declares both `X` and `ManyX`: `X`'s `updateManyX` /
 * `deleteManyX` are `ManyX`'s `update<T>` / `delete<T>` keys.
 */
export class AutoCrudNameCollisionError extends Error {
  override readonly name = 'AutoCrudNameCollisionError';

  constructor(
    readonly namespace: string,
    readonly type: string,
    readonly other: string
  ) {
    super(
      `namespace '${namespace}' declares both '${type}' and '${other}': their generated ` +
        'updateMany/deleteMany and update/delete mutation keys collide. Rename one of the types.'
    );
  }
}

export interface InstallAutoCrudOptions {
  /** Field definitions for the type — passed through to the registry entry. */
  fields?: Record<string, FieldDef>;
  /** Policy applied to every generated resolver. Defaults to the registry's default (allowAll). */
  policy?: Policy;
  /**
   * Install the admin-only `purge<T>` hard-delete mutation. Defaults to false —
   * purge is opt-in per §5.1 and §4.5 (hard-delete bypasses tombstone lifecycle).
   */
  purgeable?: boolean;
  /**
   * Capability name required to invoke `purge<T>` when `purgeable: true`.
   * Defaults to `'admin'`. Composes with `options.policy` via `and(...)` — so
   * deployments that already require authentication + specific roles keep
   * those constraints AND the admin capability on the purge path.
   */
  adminCapability?: string;
  /**
   * Optional post-write hook. When present, called by the create + update
   * resolvers after a successful write with the persisted row + request
   * context, after the engine transaction commits (see `runPostWrite`).
   * Delete resolver does NOT invoke this hook.
   */
  postWrite?: PostWriteHook;
  /** The type's natural order — published on the type entry's schema. */
  orderedBy?: OrderedBy;
  /** Declared indexes, kept on the type entry for storage to build (proposed types). */
  indexes?: IndexDecl[];
  /** Size hint, kept on the type entry for the index advisor (proposed types). */
  expectedSize?: 'small' | 'large';
}

export interface CreateResolverWithEdgesOptions {
  /** Field definitions for the type — crossRef entries drive edge emission. */
  fields?: Record<string, FieldDef>;
  /** Optional post-write hook, called after the row + edges land. */
  postWrite?: PostWriteHook;
}

/**
 * Wrap the base create resolver so every crossRef field with a non-null value
 * emits a corresponding edge post-insert — the crossRef set derives from the
 * declared `fields`, so adding a crossRef to a type definition cannot leave a
 * resolver silently writing rows with no edge. The write uses
 * the engine-supplied `args.edges` when present, falling back to the
 * closed-over handle for direct-call tests. Nested-struct crossRefs are
 * deliberately not recursed — spec §5.2 will formalise their emission path.
 *
 * When `postWrite` is provided, it is called after the row is written (and
 * after edges are emitted) with the final row + request context; see
 * `runPostWrite` for when it runs. Errors from a direct call propagate to the
 * caller — the SDK does not swallow.
 */
export function createResolverWithEdges(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  options: CreateResolverWithEdgesOptions = {}
): TypedResolver<Row> {
  return singleFrame<Row>(createBatchResolver(typeName, dataset, edges, options));
}

/**
 * `id` is coerced to string at the wire per the pg convention. Every autoCRUD
 * mutation keys on `id`, so the scalar descriptor is a shared constant.
 */
const ID_FIELD: FieldDef = { kind: 'scalar', type: 'string' };

/**
 * A struct descriptor for the autoCRUD return row. `nullable: true` marks
 * get/update (id-miss → null) without needing a separate variant.
 */
function typeStructFieldDef(fields: Record<string, FieldDef>, nullable = false): FieldDefStruct {
  return nullable ? { kind: 'struct', fields, nullable } : { kind: 'struct', fields };
}

/** `delete<T>` return shape: `{ id, deleted }`. */
function deleteReturnFieldDef(): FieldDefStruct {
  return {
    kind: 'struct',
    fields: {
      id: ID_FIELD,
      deleted: { kind: 'scalar', type: 'boolean' }
    }
  };
}

/** `updateMany<T>` / `deleteMany<T>` return shape: `{ count, ids, idsTruncated }`. */
function filterWriteReturnFieldDef(): FieldDefStruct {
  return {
    kind: 'struct',
    fields: {
      count: { kind: 'scalar', type: 'number' },
      ids: { kind: 'list', of: ID_FIELD },
      idsTruncated: { kind: 'scalar', type: 'boolean' }
    }
  };
}

/** `updateMany<T>`'s params: a filter and a patch. Both opaque here; the engine and resolver check them. */
const FILTER_WHERE: FieldDef = { kind: 'scalar', type: 'json' };

/** `purge<T>` return shape: `{ id, purged }`. */
function purgeReturnFieldDef(): FieldDefStruct {
  return {
    kind: 'struct',
    fields: {
      id: ID_FIELD,
      purged: { kind: 'scalar', type: 'boolean' }
    }
  };
}

const installedOptions = new WeakMap<object, InstallAutoCrudOptions>();

/**
 * The options `installAutoCrud` was given, looked up by the type entry's
 * resolver, so a reinstall (a field proposal) keeps the policy, postWrite and
 * purge settings. Undefined for a type autoCRUD did not install.
 */
export function autoCrudOptionsOf(typeResolver: object): InstallAutoCrudOptions | undefined {
  return installedOptions.get(typeResolver);
}

/** `X`'s first letter upper-cased: the suffix of its generated mutation keys. */
function capOf(typeName: string): string {
  return typeName.charAt(0).toUpperCase() + typeName.slice(1);
}

/**
 * Throws when another autoCRUD type in `registry` would register the same
 * mutation keys: `X` against `ManyX`, in either install order. A registry
 * without `get` (a reinstall's replace writer) is not checked.
 */
function assertNoManyCollision(registry: AutoCrudRegistry, dataset: Dataset, typeName: string) {
  const get = registry.get?.bind(registry);
  if (get === undefined) return;
  const cap = capOf(typeName);
  const others = [`Many${cap}`, `many${cap}`];
  if (cap.startsWith('Many') && cap.length > 4) {
    const base = cap.slice(4);
    others.push(base, base.charAt(0).toLowerCase() + base.slice(1));
  }
  for (const other of others) {
    const entry = other === typeName ? undefined : get(other);
    if (entry?.kind === 'type' && autoCrudOptionsOf(entry.resolver) !== undefined) {
      throw new AutoCrudNameCollisionError(dataset.namespace, typeName, other);
    }
  }
}

export function installAutoCrud(
  registry: AutoCrudRegistry,
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  options: InstallAutoCrudOptions = {}
): void {
  assertNoManyCollision(registry, dataset, typeName);
  const policy = options.policy;
  const fields = options.fields;
  const postWrite = options.postWrite;
  if (fields !== undefined) {
    assertServerSetFieldsFillable(typeName, fields);
    assertCrossRefDeletePolicies(typeName, fields);
    assertVocabImplications(typeName, fields);
  }

  const list: AutoCrudResolver = listResolver(
    typeName,
    dataset,
    fields !== undefined ? { fields } : {}
  );
  installedOptions.set(list, options);
  const get: AutoCrudResolver = getResolver(typeName, dataset);
  const hooks = {
    ...(fields !== undefined ? { fields } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(postWrite !== undefined ? { postWrite } : {})
  };
  // A mutate array calls the batch resolver once; a single frame calls it with one element.
  const createBatch = createBatchResolver(typeName, dataset, edges, hooks);
  const updateBatch = updateBatchResolver(typeName, dataset, edges, hooks);
  const deleteBatch = deleteBatchResolver(typeName, dataset, edges, hooks);
  const create: AutoCrudResolver = singleFrame<Row>(createBatch);
  const update: AutoCrudResolver = singleFrame<Row | null>(updateBatch);
  const del: AutoCrudResolver = singleFrame<Row>(deleteBatch);
  const purge: AutoCrudResolver = purgeResolver(typeName, dataset);
  // A mutation's result is an opaque row to the engine; this one carries no `id`.
  const updateMany = updateManyResolver(
    typeName,
    dataset,
    edges,
    hooks
  ) as unknown as AutoCrudResolver;
  const deleteMany = deleteManyResolver(
    typeName,
    dataset,
    edges,
    hooks
  ) as unknown as AutoCrudResolver;

  // `returns` defers to the type's declared fields (if any). No fields → no
  // struct shape for the return; substrate-pack sees the mutation returns struct
  // fields object as `{}` and treats it as "opaque row" at encode time.
  const typeFields: Record<string, FieldDef> = fields ?? {};

  // The type entry — what engine.query({ [typeName]: ... }) dispatches to.
  registry.register(typeName, {
    resolver: list,
    kind: 'type',
    ...(policy !== undefined ? { policy } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(options.orderedBy !== undefined ? { orderedBy: options.orderedBy } : {}),
    ...(options.indexes !== undefined ? { indexes: options.indexes } : {}),
    ...(options.expectedSize !== undefined ? { expectedSize: options.expectedSize } : {})
  });

  // `get<TypeName>` / `create<TypeName>` / `delete<TypeName>` — capitalise
  // first char of `typeName`. Casing is an ergonomic convention, not a
  // discriminator; `kind: 'mutation'` is what routes these to
  // `Schema.mutations`.
  const cap = capOf(typeName);

  registry.register(`get${cap}`, {
    resolver: get,
    kind: 'mutation',
    verb: 'get',
    params: { id: ID_FIELD },
    returns: typeStructFieldDef(typeFields, true),
    ...(policy !== undefined ? { policy } : {}),
    ...(fields !== undefined ? { fields } : {})
  });

  registry.register(`create${cap}`, {
    resolver: create,
    batch: createBatch,
    kind: 'mutation',
    verb: 'create',
    // `create<T>`'s params mirror the type's fields. The resolver accepts a
    // missing `id` and generates one, so `id` is part of the declared input
    // surface but not required at call time — runtime validation is the
    // resolver's job, not the schema descriptor's.
    params: typeFields,
    returns: typeStructFieldDef(typeFields),
    ...(policy !== undefined ? { policy } : {}),
    ...(fields !== undefined ? { fields } : {})
  });

  registry.register(`update${cap}`, {
    resolver: update,
    batch: updateBatch,
    kind: 'mutation',
    verb: 'update',
    // `update<T>` requires `id` plus any field to change. We declare the full
    // field set so clients can introspect what's assignable; the resolver
    // decides at runtime which fields to apply.
    params: { id: ID_FIELD, ...typeFields },
    returns: typeStructFieldDef(typeFields, true),
    ...(policy !== undefined ? { policy } : {}),
    ...(fields !== undefined ? { fields } : {})
  });

  registry.register(`delete${cap}`, {
    resolver: del,
    batch: deleteBatch,
    kind: 'mutation',
    verb: 'delete',
    params: { id: ID_FIELD },
    returns: deleteReturnFieldDef(),
    ...(policy !== undefined ? { policy } : {})
    // delete returns `{ id, deleted }` — intentionally doesn't carry the
    // type's `fields` map. Emitting the type's schema on a delete mutation
    // would mislead clients into thinking they can select arbitrary fields.
  });

  // By filter. The engine validates `where` against `filterTarget` as a
  // query's, and the resolver checks `set` as update<T> checks a patch.
  registry.register(`updateMany${cap}`, {
    resolver: updateMany,
    kind: 'mutation',
    verb: 'update',
    filterTarget: typeName,
    params: { where: FILTER_WHERE, set: typeStructFieldDef(typeFields) },
    returns: filterWriteReturnFieldDef(),
    ...(policy !== undefined ? { policy } : {})
  });

  registry.register(`deleteMany${cap}`, {
    resolver: deleteMany,
    kind: 'mutation',
    verb: 'delete',
    filterTarget: typeName,
    params: { where: FILTER_WHERE },
    returns: filterWriteReturnFieldDef(),
    ...(policy !== undefined ? { policy } : {})
  });

  // §5.1 admin-only hard-delete. Opt-in: callers that want a purge surface
  // must explicitly set `purgeable: true`. The default admin capability is
  // `'admin'` — deployments can override via `options.adminCapability` (wired
  // from `SUBSTRATE_ADMIN_CAPABILITY` in the binary, §5.12). Composes with any
  // caller-supplied policy via `and(...)` so role/auth bars stay in force.
  if (options.purgeable === true) {
    const capabilityName = options.adminCapability ?? 'admin';
    const adminGate = requireCapability(capabilityName);
    const purgePolicy = policy !== undefined ? and(policy, adminGate) : adminGate;
    registry.register(`purge${cap}`, {
      resolver: purge,
      kind: 'mutation',
      // Semantically a (hard) delete — verb-keyed deny-delete policies catch purge too.
      verb: 'delete',
      params: { id: ID_FIELD },
      returns: purgeReturnFieldDef(),
      policy: purgePolicy
    });
  }
}
