/**
 * The per-frame gate checks both dimensions of a grant — namespace AND
 * capability — in one place (spec §2 / step 4), so a grant can say what is
 * allowed in each namespace and a read grant is not also a write grant.
 */

import type { Identity } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { checkIdentityGrant } from '../src/engine/internals.js';

const grantOf = (grants: Record<string, string[]>) => ({ id: 'a', grants });

describe('checkIdentityGrant — a grant that narrows WITHIN a namespace', () => {
  const readOnlyNotes = grantOf({ notes: ['read'], tasks: ['read', 'mutate'] });

  it('permits a read where the grant is read-only', () => {
    expect(checkIdentityGrant(readOnlyNotes, 'notes', 'query').ok).toBe(true);
  });

  it('REFUSES a mutate where the grant is read-only — the whole point', () => {
    expect(checkIdentityGrant(readOnlyNotes, 'notes', 'mutate').ok).toBe(false);
  });

  it('permits a mutate where the grant allows it', () => {
    expect(checkIdentityGrant(readOnlyNotes, 'tasks', 'mutate').ok).toBe(true);
  });

  it('refuses a namespace the grant does not name at all', () => {
    expect(checkIdentityGrant(readOnlyNotes, 'billing', 'query').ok).toBe(false);
  });

  it('treats subscribe and stream as reads', () => {
    expect(checkIdentityGrant(readOnlyNotes, 'notes', 'subscribe').ok).toBe(true);
    expect(checkIdentityGrant(readOnlyNotes, 'notes', 'stream').ok).toBe(true);
  });

  it('distinguishes "namespace not granted" from "not for this operation"', () => {
    // Both are refusals, and an operator needs to know which — one is a missing
    // grant, the other a deliberately narrowed one.
    const missing = checkIdentityGrant(readOnlyNotes, 'billing', 'mutate');
    const narrowed = checkIdentityGrant(readOnlyNotes, 'notes', 'mutate');
    expect(missing.ok).toBe(false);
    expect(narrowed.ok).toBe(false);
    if (!missing.ok && !narrowed.ok) {
      expect(missing.reason).toBe('namespace');
      expect(narrowed.reason).toBe('capability');
    }
  });
});

describe('the wildcard entry', () => {
  it('covers a namespace it does not name explicitly', () => {
    const g = grantOf({ '*': ['read'] });
    expect(checkIdentityGrant(g, 'anything', 'query').ok).toBe(true);
    expect(checkIdentityGrant(g, 'anything', 'mutate').ok).toBe(false);
  });

  it('is beaten by an explicit entry for that namespace', () => {
    const g = grantOf({ '*': ['read'], tasks: ['read', 'mutate'] });
    expect(checkIdentityGrant(g, 'tasks', 'mutate').ok).toBe(true);
    expect(checkIdentityGrant(g, 'notes', 'mutate').ok).toBe(false);
  });
});

/**
 * Identities with no `grants` — direct-call tests and system actors — are the
 * no-claim population and pass HERE; the route wrapper is authoritative for
 * HTTP gating and refuses them there.
 *
 * The flat `namespaces`/`capabilities` fields are IGNORED: an identity carrying
 * only those resolves to `null` exactly like a bare `{ id }`, so it passes this
 * gate even for a namespace the flat list never named. The route gate
 * (`confersAnywhere` over `null` is false) refuses it for HTTP. The last test
 * pins that flat data never decides a verdict.
 */
describe('identities without a grant are the no-claim population', () => {
  // The runtime shape; the type no longer advertises it. `as unknown as`
  // rather than a partial: a Partial<Identity> would still satisfy the gate's
  // parameter without exercising what a grants-less object actually does.
  const bare = { id: 'a' } as unknown as Identity;
  const flat = { id: 'a', namespaces: ['tasks'], capabilities: ['read'] } as unknown as Identity;

  it('passes a null identity through, as the old gate did', () => {
    expect(checkIdentityGrant(null, 'anything', 'mutate').ok).toBe(true);
  });

  it('passes a bare id through — the route wrapper decides for HTTP', () => {
    expect(checkIdentityGrant(bare, 'anything', 'mutate').ok).toBe(true);
  });

  it('IGNORES flat fields rather than honoring them', () => {
    // Passes even where the flat list names nothing: with no grant there is
    // no claim, and no claim passes HERE. Refusal for HTTP happens at the
    // route gate, which reads the same null as false.
    expect(checkIdentityGrant(flat, 'tasks', 'query').ok).toBe(true);
    expect(checkIdentityGrant(flat, 'notes', 'query').ok).toBe(true);
  });
});
