import type { ActorIdentity, RequestContext } from '@mnmal-ai/substrate-types';

/**
 * Maps a RequestContext.identity (auth principal from policy.ts) into the
 * row-attribution ActorIdentity used by Tier-1 row metadata.
 *
 * The auth `Identity` in policy.ts carries { id, grants, roles?, scopes?,
 * kid?, [k]: unknown } — no built-in type discriminator.
 * Resolution is by presence of convention fields on the index signature:
 *
 *   - `agentKeyId` present  → kind='agent',  id=agentKeyId   (JWT-verified agent key)
 *   - `tokenId` present     → kind='user',   id=tokenId      (static token / human session)
 *   - `kind='system'` + id  → kind='system', id=identity.id  (explicit system envelope from internal callers)
 *   - anything else         → THROWS {@link UnattributedWriteError}
 *
 * Called to fill `createdBy` / `updatedBy` on every autoCRUD row write.
 *
 * Substrate accepts no unattributed write, so there is deliberately no default
 * actor: an internal writer passes `{ kind: 'system', id: '<component>' }`, and
 * an unauthenticated deployment declares its actor at boot (`compose`'s
 * `systemActor`).
 */

/**
 * A write that cannot say who made it. Thrown rather than defaulted: a default
 * actor would read as attribution in the audit trail while naming nobody.
 */
export class UnattributedWriteError extends Error {
  override readonly name = 'UnattributedWriteError';
  readonly code = 'unattributed_write';
}
export function resolveIdentity(ctx: Pick<RequestContext, 'identity'>): ActorIdentity {
  const ident = ctx.identity;
  if (ident === null || ident === undefined) {
    throw new UnattributedWriteError(
      'refusing an unattributed write: no identity on the request context. ' +
        'An authenticated caller supplies one; an internal writer passes an ' +
        "explicit system envelope such as { kind: 'system', id: 'nightly-sweep' }; " +
        'an unauthenticated deployment declares one at boot (systemActor / SUBSTRATE_SYSTEM_ACTOR).'
    );
  }
  // Agent JWT — discriminated by the presence of `agentKeyId` on the token envelope.
  if (
    'agentKeyId' in ident &&
    typeof ident.agentKeyId === 'string' &&
    ident.agentKeyId.length > 0
  ) {
    return { kind: 'agent', id: ident.agentKeyId };
  }
  // Static token / human session — discriminated by `tokenId`.
  if ('tokenId' in ident && typeof ident.tokenId === 'string' && ident.tokenId.length > 0) {
    return { kind: 'user', id: ident.tokenId };
  }
  // Explicit system envelope — internal callers (sweep, compaction, bootstrap) pass
  // `{ kind: 'system', id: '<component>' }` directly in the RequestContext.
  if (ident.kind === 'system' && typeof ident.id === 'string' && ident.id.length > 0) {
    return { kind: 'system', id: ident.id };
  }
  // Unrecognised shape — refuse rather than invent an actor.
  throw new UnattributedWriteError(
    'refusing an unattributed write: the request identity matched no known ' +
      "shape (expected agentKeyId, tokenId, or an explicit { kind: 'system', id }). " +
      'Attribution cannot be inferred, so it is not invented.'
  );
}
