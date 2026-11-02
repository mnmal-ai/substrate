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
 *
 * Filter-based update — `updateTodo({ where }, { ...newFields })` — is spec
 * §5.2.1 and not implemented.
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
    }
  ): void;
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

export function installAutoCrud(
  registry: AutoCrudRegistry,
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  options: InstallAutoCrudOptions = {}
): void {
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
  const cap = typeName.charAt(0).toUpperCase() + typeName.slice(1);

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
