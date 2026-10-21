import type { Identity } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { resolveIdentity, UnattributedWriteError } from '../src/autocrud/resolve-identity.js';

/**
 * Fixtures use `Identity`'s index signature (`[k: string]: unknown`) to
 * carry discriminating fields that the resolver branches on:
 *
 *   - agentKeyId  → kind='agent'  (JWT-verified agent key)
 *   - tokenId     → kind='user'   (static token / human session)
 *   - kind='system' + id          → kind='system' (explicit system envelope)
 *   - null / unrecognised shape   → throws UnattributedWriteError
 *
 * The real `Identity` in policy.ts carries { id, grants,
 * roles?, scopes?, kid?, [k]: unknown } — no built-in type discriminator.
 * Resolution is by presence of convention fields.
 */
describe('resolveIdentity', () => {
  it('agent JWT (agentKeyId present) → kind=agent, id=<agentKeyId>', () => {
    const identity: Identity = {
      id: 'k-1',
      agentKeyId: 'k-1',
      grants: { claude: ['read', 'mutate'] }
    };
    const ctx = { identity };
    expect(resolveIdentity(ctx)).toEqual({ kind: 'agent', id: 'k-1' });
  });

  it('static token / human session (tokenId present) → kind=user, id=<tokenId>', () => {
    const identity: Identity = {
      id: 'tok-abc',
      tokenId: 'tok-abc',
      grants: { '*': ['read'] }
    };
    const ctx = { identity };
    expect(resolveIdentity(ctx)).toEqual({ kind: 'user', id: 'tok-abc' });
  });

  it('explicit system envelope (kind=system + id present) → kind=system, id preserved', () => {
    // Used by internal callers: sweep, compaction, bootstrap, etc.
    const identity: Identity = { id: 'sweep', kind: 'system', grants: { '*': ['read', 'mutate'] } };
    const ctx = { identity };
    expect(resolveIdentity(ctx)).toEqual({ kind: 'system', id: 'sweep' });
  });

  it('admin secret bootstrap (kind=system, id=admin) → kind=system, id=admin', () => {
    const identity: Identity = { id: 'admin', kind: 'system', grants: { '*': ['read', 'mutate'] } };
    const ctx = { identity };
    expect(resolveIdentity(ctx)).toEqual({ kind: 'system', id: 'admin' });
  });
});

/**
 * No write is accepted without an actor: a null or unrecognised identity is
 * refused rather than defaulted to `anonymous` / `unknown`. Internal writers
 * use the explicit system envelope (e.g. `system:nightly-sweep`).
 */
describe('resolveIdentity refuses to invent an actor', () => {
  it('refuses a null identity rather than attributing it to `anonymous`', () => {
    expect(() => resolveIdentity({ identity: null })).toThrow(UnattributedWriteError);
  });

  it('refuses an undefined identity the same way', () => {
    expect(() => resolveIdentity({ identity: undefined } as never)).toThrow(UnattributedWriteError);
  });

  it('refuses an unrecognised shape rather than attributing it to `unknown`', () => {
    expect(() => resolveIdentity({ identity: { id: '' } as never })).toThrow(
      UnattributedWriteError
    );
  });

  it('names what to do — a refusal nobody can act on gets routed around', () => {
    let message = '';
    try {
      resolveIdentity({ identity: null });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/system/i);
  });

  it('still accepts an explicit system envelope — internal writers declare themselves', () => {
    expect(
      resolveIdentity({
        identity: {
          kind: 'system',
          id: 'nightly-sweep',
          grants: { '*': ['read', 'mutate'] }
        } as never
      })
    ).toEqual({ kind: 'system', id: 'nightly-sweep' });
  });
});
