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

import { and, applyRowFilters, requireCapability } from '@mnmal-ai/substrate-policy';
import type {
  AutoCrudVerb,
  Dataset,
  EdgesStore,
  FieldDef,
  FieldDefStruct,
  Id,
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
import { resolveEntityId } from '../short-id-resolver.js';
import { createResolver } from './autocrud-create.js';
import { deleteResolver } from './autocrud-delete.js';
import { getResolver } from './autocrud-get.js';
import { listResolver } from './autocrud-list.js';
import { purgeResolver } from './autocrud-purge.js';
import { updateResolver } from './autocrud-update.js';
import { assertCrossRefTargetsExist, collectCrossRefFields } from './crossref-existence.js';
import { assertServerSetFieldsFillable, assertVocabImplications, coerceId } from './internal.js';

export { createResolver } from './autocrud-create.js';
export { deleteResolver } from './autocrud-delete.js';
export { getResolver } from './autocrud-get.js';
export { listResolver } from './autocrud-list.js';
export { purgeResolver } from './autocrud-purge.js';
export type { UpdateResolverOptions } from './autocrud-update.js';
export { applyUpdatePatch, updateResolver } from './autocrud-update.js';

/**
 * The narrow surface `installAutoCrud` needs from a registry. The core
 * `Registry` class satisfies this structurally.
 *
 * Resolver signature matches the core `Resolver` type exactly — typed against
 * `(ctx, args) => Promise<Row | Row[] | null>` so autocrud's `get` can surface
 * null without sentinel gymnastics.
 */
/**
 * A row policy filters what a read returns, so on its own it would let an
 * update or delete reach a row the caller cannot read. Run the policy's row
 * filters against the stored row first and answer as for a missing row.
 */
function guardRowWrite(
  typeName: string,
  dataset: Dataset,
  policy: Policy | undefined,
  hidden: (id: Id) => Row | null,
  resolver: AutoCrudResolver
): AutoCrudResolver {
  if (policy === undefined) return resolver;
  return async (ctx, args) => {
    const id = coerceId(args.params?.id);
    if (id === undefined) return resolver(ctx, args);
    const decision = policy(ctx, args);
    if (decision.obligations === undefined || decision.obligations.length === 0) {
      return resolver(ctx, args);
    }
    const ds = args.dataset ?? dataset;
    const rowId = await resolveEntityId(ds, typeName, id);
    const stored = rowId === null ? undefined : (await ds.read(typeName, { id: rowId })).rows[0];
    if (stored !== undefined && applyRowFilters(decision, [stored], ctx).length === 0) {
      return hidden(id);
    }
    return resolver(ctx, args);
  };
}

export type AutoCrudResolver = (
  ctx: RequestContext,
  args: ResolverArgs
) => Promise<Row | Row[] | ReadResult | null>;

export interface AutoCrudRegistry {
  register(
    typeName: string,
    input: {
      resolver: AutoCrudResolver;
      policy?: Policy;
      fields?: Record<string, FieldDef>;
      kind?: 'type' | 'mutation';
      params?: Record<string, FieldDef>;
      returns?: FieldDef;
      orderedBy?: OrderedBy;
      indexes?: IndexDecl[];
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
  const { fields, postWrite } = options;
  const crossRefs = collectCrossRefFields(fields);
  const base = createResolver(typeName, dataset, fields !== undefined ? { fields } : {});

  return async (ctx, args) => {
    const ds = args.dataset ?? dataset;
    // Refuse edges to non-existent targets before writing anything.
    await assertCrossRefTargetsExist(args, crossRefs, args.params ?? {}, ds.namespace);

    // `base` returns the stored canonical row.
    const createdRow = await base(ctx, args);
    const edgeStore = args.edges ?? edges;

    // Each crossRef field maps to one independent edge write — no inter-write
    // dependency — so fire them concurrently.
    const edgeWrites: Array<Promise<unknown>> = [];
    for (const { fieldName, def } of crossRefs) {
      const value = createdRow[fieldName];
      if (value == null) continue;
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      edgeWrites.push(
        edgeStore.write({
          from: { ns: ds.namespace, type: typeName, id: createdRow.id },
          to: { ns: def.ns, type: def.type, id: value },
          fieldName,
          policy: def.onDelete
        })
      );
    }
    if (edgeWrites.length > 0) await Promise.all(edgeWrites);

    if (postWrite !== undefined) {
      await runPostWrite(postWrite, typeName, dataset, createdRow, ctx, args);
    }
    return createdRow;
  };
}

/**
 * Runs `postWrite` once the engine transaction commits, on the row as
 * committed, so its side effects (embeddings, indexes) never describe a
 * rolled-back write or hold a connection across the transaction. A rolled-back
 * write skips it. Outside a transaction (no `afterTx`) it runs at once.
 */
async function runPostWrite(
  postWrite: PostWriteHook,
  typeName: string,
  dataset: Dataset,
  row: Row,
  ctx: RequestContext,
  args: ResolverArgs
): Promise<void> {
  if (args.afterTx === undefined) {
    await postWrite(row, ctx);
    return;
  }
  args.afterTx(async (outcome) => {
    // shortcut: a commit whose reply was lost reads as a rollback, so its row
    // is never indexed until POST /substrate/v1/embed/reindex or
    // /substrate/v1/lexical/reindex runs; re-read by id after reconnect to
    // recover it automatically.
    if (!outcome.committed) return;
    const { rows } = await dataset.read(typeName, { id: row.id });
    const committed = rows[0];
    if (committed !== undefined) await postWrite(committed, ctx);
  });
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
    assertVocabImplications(typeName, fields);
  }

  const list: AutoCrudResolver = listResolver(
    typeName,
    dataset,
    fields !== undefined ? { fields } : {}
  );
  installedOptions.set(list, options);
  const get: AutoCrudResolver = getResolver(typeName, dataset);
  const create: AutoCrudResolver = createResolverWithEdges(typeName, dataset, edges, {
    ...(fields !== undefined ? { fields } : {}),
    ...(postWrite !== undefined ? { postWrite } : {})
  });
  const baseUpdate = updateResolver(
    typeName,
    dataset,
    edges,
    fields !== undefined ? { fields } : {}
  );
  const update: AutoCrudResolver = guardRowWrite(
    typeName,
    dataset,
    policy,
    () => null,
    postWrite !== undefined
      ? async (ctx, args) => {
          const result = await baseUpdate(ctx, args);
          if (result !== null) {
            await runPostWrite(postWrite, typeName, dataset, result as Row, ctx, args);
          }
          return result;
        }
      : (baseUpdate as AutoCrudResolver)
  );
  const del: AutoCrudResolver = guardRowWrite(
    typeName,
    dataset,
    policy,
    (id) => ({ id, deleted: false }) as unknown as Row,
    deleteResolver(typeName, dataset, edges)
  );
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
    ...(options.indexes !== undefined ? { indexes: options.indexes } : {})
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
