/**
 * Substrate.propose capability policy helper.
 */

import { requireCapability } from '@mnmal-ai/substrate-policy';
import type { Policy } from '@mnmal-ai/substrate-types';

export const DEFAULT_PROPOSE_CAPABILITY = 'substrate.propose';
/** Changes a type's indexes or natural order (`propose_index`); separate from proposing schema. */
export const DEFAULT_INDEX_CAPABILITY = 'substrate.index';

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
 * live schema. A write that sets a type's indexes or natural order also needs
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
    if (!decision.allow || !INDEX_FIELDS.some((f) => params[f] != null)) return decision;
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
