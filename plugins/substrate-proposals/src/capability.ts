/**
 * Substrate.propose capability policy helper.
 */

import { requireCapability } from '@mnmal-ai/substrate-policy';
import type { Policy } from '@mnmal-ai/substrate-types';

export const DEFAULT_PROPOSE_CAPABILITY = 'substrate.propose';

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

/**
 * Writes to the proposal record types need the propose capability: boot
 * replays every row marked applied, so a row written directly would become
 * live schema. Reads stay open to anyone the namespace grant admits.
 */
export function proposeToWrite(capability: string = DEFAULT_PROPOSE_CAPABILITY): Policy {
  const gate = makeProposePolicy(capability);
  return (ctx, args) => (ctx.operation === 'mutate' ? gate(ctx, args) : { allow: true });
}
