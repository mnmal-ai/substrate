/**
 * Substrate.propose capability policy helper.
 */

import { requireCapability } from '@mnmal-ai/substrate-policy';
import {
  type Dataset,
  type Id,
  type Policy,
  type Registry,
  type RegistryEntryResolver,
  type RequestContext,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import { isLiveProposal, lockedInIdOrder, lockedRow } from './row-lock.js';

export const DEFAULT_PROPOSE_CAPABILITY = 'substrate.propose';
/** Changes a type's indexes or natural order (`propose_index`); separate from proposing schema. */
export const DEFAULT_INDEX_CAPABILITY = 'substrate.index';
/** What `drop_type` / `drop_namespace` require in the target namespace (the compose default). */
export const DEFAULT_DROP_CAPABILITY = 'admin';

/**
 * Create a policy that requires the given capability to be present in the
 * request identity. Passing an empty string disables the gate entirely
 * (allow-all) — intended for dev / smoke-test deployments where JWT auth
 * isn't configured and every request would otherwise have no identity.
 * Production deployments should always supply a real capability name.
 */
export function makeProposePolicy(capability: string = DEFAULT_PROPOSE_CAPABILITY): Policy {
  if (capability === '') {
    return () => ({ allow: true });
  }
  return requireCapability(capability);
}

/** TypeProposal fields boot replays as indexes and natural order. */
const INDEX_FIELDS = ['indexesJson', 'orderedByJson'] as const;

/**
 * Writes to the proposal record types need the propose capability: boot
 * replays every row marked applied, so a row written directly would become
 * live schema. A write that names a type's indexes or natural order (null, which clears
 * them, included) also needs
 * the index capability, which `propose_index` is gated by. Reads stay open to
 * anyone the namespace grant admits.
 */
export function proposeToWrite(
  capability: string = DEFAULT_PROPOSE_CAPABILITY,
  indexCapability: string = DEFAULT_INDEX_CAPABILITY
): Policy {
  const gate = makeProposePolicy(capability);
  const indexGate = makeProposePolicy(indexCapability);
  return (ctx, args) => {
    if (ctx.operation !== 'mutate') return { allow: true };
    const decision = gate(ctx, args);
    const params = args.params ?? {};
    if (!decision.allow || !INDEX_FIELDS.some((f) => f in params)) return decision;
    return indexGate(ctx, args);
  };
}

/**
 * `propose_index`'s gate: the index capability in the namespace whose indexes
 * the call changes (`params.namespace`), else in the frame's namespace.
 */
export function makeIndexPolicy(capability: string = DEFAULT_INDEX_CAPABILITY): Policy {
  const gate = makeProposePolicy(capability);
  return (ctx, args) => {
    const target = args.params?.namespace;
    return gate(typeof target === 'string' ? { ...ctx, namespace: target } : ctx, args);
  };
}

/** Whether `typeName` has rows, archived and tombstoned ones included (purged ones are gone). */
export async function typeHasRows(dataset: Dataset, typeName: string): Promise<boolean> {
  return (await dataset.read(typeName, { includeDeleted: true, limit: 1 })).rows.length > 0;
}

/**
 * TypeProposal and FieldProposal fields boot replay never reads, and no write
 * of which changes stored data: an update that touches only these leaves the
 * replayed type or field as it was. Anything else, a field added later
 * included, is checked.
 */
const BENIGN_PROPOSAL_FIELDS = new Set([
  'id',
  'proposedReason',
  'proposedBy',
  'proposedAt',
  'resultingSchemaVersion'
]);

/**
 * Why `typeName` is already defined, or undefined when it is free: it has
 * stored rows, or another live (applied, not archived) proposal defines it.
 * A second live definition would make boot replay choose between them.
 */
async function defined(
  dataset: Dataset,
  typeName: string,
  exceptId?: Id
): Promise<string | undefined> {
  if (await typeHasRows(dataset, typeName)) return 'has stored rows';
  const live = await dataset.read('TypeProposal', {
    where: {
      AND: [{ typeName: { eq: typeName } }, { applied: { eq: true } }, { archived: { eq: false } }]
    },
    limit: 2
  });
  return live.rows.some((r) => r.id !== exceptId) ? 'already has an applied proposal' : undefined;
}

/**
 * Marks a write the plugin makes on its own behalf after it has authorised the
 * whole operation (propose_type's step 5, propose_field's writes). A symbol, so
 * no wire frame can set it.
 */
export const TRUSTED_WRITE: unique symbol = Symbol('substrate-proposals.trustedWrite');

/**
 * Deleting a TypeProposal, or any update that changes what boot replays
 * (archiving, `applied`, renaming `typeName`, `fieldsJson`, ...), drops or
 * redefines its type at the next boot. For a type with storage that needs the
 * drop capability, as `drop_type` does; a proposal for a type with no rows
 * stays the propose capability's alone (#1792, #1954). Storage is checked
 * under the proposal's stored `typeName`, read before the write, so a rename
 * cannot point the check at an empty name. An update that leaves the proposal
 * live (a rename's target, or a return to live) also needs it when the name it
 * leaves has stored rows or another live proposal. The proposal is found as
 * the write finds it (a raw id, then a short id), locked until the write's
 * transaction ends, and the write then reaches it by its stored id, so the
 * row checked is the row written. A removal whose proposal cannot be loaded
 * or locked is refused. A mutate array runs per element through the guard,
 * an array of updates or deletes first locking every row it names in id
 * order, and `updateMany` / `deleteMany` refuse once their single-row entry
 * is replaced. An empty capability opts out.
 */
export function gateTypeProposalRemoval(
  registry: Registry,
  dropCapability: string = DEFAULT_DROP_CAPABILITY
): void {
  if (dropCapability === '') return;
  const gate = makeProposePolicy(dropCapability);
  const removes: Record<string, (params: Record<string, unknown>) => boolean> = {
    deleteTypeProposal: () => true,
    updateTypeProposal: (params) => Object.keys(params).some((k) => !BENIGN_PROPOSAL_FIELDS.has(k)),
    // A fresh applied proposal for a stored name redefines that type at boot (#1956).
    createTypeProposal: (params) => params.applied === true
  };
  for (const [key, isRemoval] of Object.entries(removes)) {
    const entry = registry.get(key);
    if (entry === undefined) continue;
    const { batch: _batch, resolver, ...rest } = entry;
    const deny = (ctx: RequestContext, why: string): ResolverFrameError =>
      new ResolverFrameError('policy_denied', `${key}: ${why}`, {
        required: `${ctx.namespace}:${dropCapability}`
      });
    const guard: RegistryEntryResolver = async (ctx, args) => {
      const params = args.params ?? {};
      const trusted = (args as { [TRUSTED_WRITE]?: true })[TRUSTED_WRITE] === true;
      if (!trusted && isRemoval(params) && !gate(ctx, args).allow) {
        if (key === 'createTypeProposal') {
          // No stored row yet: the name it would apply is the one to check.
          const name = params.typeName;
          if (args.dataset === undefined) {
            throw deny(
              ctx,
              `cannot check '${String(name)}' for stored rows; needs '${dropCapability}'`
            );
          }
          const why = typeof name === 'string' ? await defined(args.dataset, name) : undefined;
          if (why !== undefined) {
            throw deny(
              ctx,
              `'${String(name)}' ${why}; an applied proposal for it redefines the type, which needs '${dropCapability}' as drop_type does`
            );
          }
          return resolver(ctx, args);
        }
        const { dataset } = args;
        const row = await lockedRow('TypeProposal', params.id, dataset);
        if (row === null || dataset === undefined) {
          throw deny(
            ctx,
            `cannot load the proposal to check its type for stored rows; needs '${dropCapability}'`
          );
        }
        const stored = row.typeName;
        if (typeof stored === 'string' && (await typeHasRows(dataset, stored))) {
          throw deny(
            ctx,
            `'${stored}' has stored rows; this change to its proposal drops or redefines the type, which needs '${dropCapability}' as drop_type does`
          );
        }
        // A proposal left live by this update (applied, not archived) must be the
        // only definition of its name, the stored one or a rename's target.
        const name = typeof params.typeName === 'string' ? params.typeName : stored;
        const live =
          (params.applied ?? row.applied) === true && (params.archived ?? row.archived) !== true;
        if (live && typeof name === 'string') {
          const why = await defined(dataset, name, row.id);
          if (why !== undefined) {
            throw deny(
              ctx,
              `'${name}' ${why}; this change makes a second live definition of it, which needs '${dropCapability}' as drop_type does`
            );
          }
        }
        return resolver(ctx, { ...args, params: { ...params, id: row.id } });
      }
      return resolver(ctx, args);
    };
    registry.replace(key, {
      ...rest,
      resolver: guard,
      // A create names no stored row to lock.
      ...(key === 'createTypeProposal' ? {} : { batch: lockedInIdOrder('TypeProposal', guard) })
    });
  }
}

/**
 * A FieldProposal write can drop, redefine, reorder or bring back a field at
 * the next boot, and a `valueMapJson` rewrites stored values. A create,
 * update or delete is let through when the plugin makes it for itself
 * ({@link TRUSTED_WRITE}), when every param is one boot replay never reads
 * (`BENIGN_PROPOSAL_FIELDS`; a delete never is), or when the writer holds the
 * drop capability, as `drop_type` needs. Otherwise it is refused when a type
 * it affects has stored rows: the type a live proposal it changes or deletes
 * targets (the field as it stands), and the type a proposal it leaves live,
 * or creates live, targets (the field as it will stand, after a retarget, a
 * rename or a return to live). A target that is not a string is refused as
 * unknowable. As for TypeProposal, an updated or deleted proposal is found as
 * the write finds it, locked until the write's transaction ends, and written
 * by its stored id; one that cannot be loaded or locked is refused; an array
 * of updates or deletes first locks every row it names in id order; and
 * `updateMany` / `deleteMany` refuse once their single-row entry is replaced.
 * Params whose value is undefined are left out first, as the update resolver
 * leaves them. An empty capability opts out.
 */
export function gateFieldProposalRemoval(
  registry: Registry,
  dropCapability: string = DEFAULT_DROP_CAPABILITY
): void {
  if (dropCapability === '') return;
  const gate = makeProposePolicy(dropCapability);
  for (const key of ['createFieldProposal', 'deleteFieldProposal', 'updateFieldProposal']) {
    const entry = registry.get(key);
    if (entry === undefined) continue;
    const { batch: _batch, resolver, ...rest } = entry;
    const isCreate = key === 'createFieldProposal';
    const isDelete = key === 'deleteFieldProposal';
    const guard: RegistryEntryResolver = async (ctx, args) => {
      const params = Object.fromEntries(
        Object.entries(args.params ?? {}).filter(([, v]) => v !== undefined)
      );
      const trusted = (args as { [TRUSTED_WRITE]?: true })[TRUSTED_WRITE] === true;
      // A delete names only its id, and is never benign.
      const benign = !isDelete && Object.keys(params).every((k) => BENIGN_PROPOSAL_FIELDS.has(k));
      if (trusted || benign || gate(ctx, args).allow) return resolver(ctx, args);
      const deny = (why: string): ResolverFrameError =>
        new ResolverFrameError('policy_denied', `${key}: ${why}`, {
          required: `${ctx.namespace}:${dropCapability}`
        });
      const { dataset } = args;
      const row = isCreate ? null : await lockedRow('FieldProposal', params.id, dataset);
      if (dataset === undefined || (!isCreate && row === null)) {
        throw deny(
          `cannot load the proposal to check its target type for stored rows; needs '${dropCapability}'`
        );
      }
      /** Why a live proposal `r` must not change unchecked: its target's rows. */
      const populated = async (r: Record<string, unknown>): Promise<string | undefined> => {
        const target = r.targetType;
        if (typeof target !== 'string') return 'names no target type to check for stored rows';
        return (await typeHasRows(dataset, target)) ? `'${target}' has stored rows` : undefined;
      };
      if (row !== null && isLiveProposal(row)) {
        const why = await populated(row);
        if (why !== undefined) {
          throw deny(
            `${why}; this change to a live proposal of its field '${String(row.fieldName)}' drops or redefines the field, which needs '${dropCapability}' as drop_type does`
          );
        }
      }
      const after = isDelete ? undefined : { ...row, ...params };
      if (after !== undefined && isLiveProposal(after)) {
        const why = await populated(after);
        if (why !== undefined) {
          throw deny(
            `${why}; this change leaves a live proposal of its field '${String(after.fieldName)}', which redefines the field and needs '${dropCapability}' as drop_type does`
          );
        }
      }
      return resolver(
        ctx,
        row === null ? args : { ...args, params: { ...args.params, id: row.id } }
      );
    };
    registry.replace(key, {
      ...rest,
      resolver: guard,
      // A create names no stored row to lock.
      ...(isCreate ? {} : { batch: lockedInIdOrder('FieldProposal', guard) })
    });
  }
}
