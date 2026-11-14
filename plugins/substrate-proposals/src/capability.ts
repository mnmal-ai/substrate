/**
 * Substrate.propose capability policy helper.
 */

import { requireCapability } from '@mnmal-ai/substrate-policy';
import {
  type Dataset,
  type Policy,
  type Registry,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';

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
 * Deleting or archiving a TypeProposal drops its type's definition at the next
 * boot, so for a type with storage it needs the drop capability, as
 * `drop_type` does; a proposal for a type with no rows stays the propose
 * capability's alone (#1792). The guarded entries lose `batch`, so a mutate
 * array runs per element through the guard, and `updateMany` / `deleteMany`
 * refuse once their single-row entry is replaced. An empty capability opts out.
 */
export function gateTypeProposalRemoval(
  registry: Registry,
  dropCapability: string = DEFAULT_DROP_CAPABILITY
): void {
  if (dropCapability === '') return;
  const gate = makeProposePolicy(dropCapability);
  const removes: Record<string, (params: Record<string, unknown>) => boolean> = {
    deleteTypeProposal: () => true,
    updateTypeProposal: (params) => params.archived === true
  };
  for (const [key, isRemoval] of Object.entries(removes)) {
    const entry = registry.get(key);
    if (entry === undefined) continue;
    const { batch: _batch, resolver, ...rest } = entry;
    registry.replace(key, {
      ...rest,
      resolver: async (ctx, args) => {
        const params = args.params ?? {};
        const id = params.id;
        if (isRemoval(params) && typeof id === 'string' && args.dataset !== undefined) {
          const { rows } = await args.dataset.read('TypeProposal', { id, limit: 1 });
          const typeName = rows[0]?.typeName;
          if (typeof typeName === 'string' && (await typeHasRows(args.dataset, typeName))) {
            const decision = gate(ctx, args);
            if (!decision.allow) {
              throw new ResolverFrameError(
                'policy_denied',
                `${key}: '${typeName}' has stored rows; removing its proposal drops the type, which needs '${dropCapability}' as drop_type does`,
                { required: `${ctx.namespace}:${dropCapability}` }
              );
            }
          }
        }
        return resolver(ctx, args);
      }
    });
  }
}
