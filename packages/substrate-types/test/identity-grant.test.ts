/**
 * `grantOf` reads `grants` and nothing else.
 *
 * The tri-state is what these tests are mostly about. `null` is not "an empty
 * grant"; it is "this identity makes no claim", and the two gates read it in
 * OPPOSITE directions — the engine gate passes it (direct-call tests, system
 * actors), the route gate refuses it. Collapsing it toward either would break
 * one of them silently, so the population boundaries are pinned here.
 *
 * An identity carrying only the flat `namespaces`/`capabilities` fields
 * resolves to `null` — ignored, not honored.
 */

import { describe, expect, it } from 'vitest';
import {
  confersAnywhere,
  coversNamespace,
  grantedIn,
  grantOf,
  type IdentityGrant
} from '../src/identity-grant.js';

describe('grantOf — grants in, grant out, null for no claim', () => {
  it('returns the grant verbatim when one is present', () => {
    expect(grantOf({ grants: { tasks: ['read', 'mutate'], notes: ['read'] } })).toEqual({
      tasks: ['read', 'mutate'],
      notes: ['read']
    });
  });

  it('IGNORES flat fields — they neither grant nor refuse', () => {
    // A flat claim is dead weight: no grant key means no claim means null, and
    // the ENGINE gate passes null. Refusal for HTTP happens at the route gate.
    // Casts: the TYPE no longer admits these shapes — this pins what the
    // runtime does with them anyway (JS callers, stale peers, old rows).
    type In = Parameters<typeof grantOf>[0];
    expect(
      grantOf({
        namespaces: ['tasks', 'recall'],
        capabilities: ['read', 'mutate']
      } as unknown as In)
    ).toBeNull();
    expect(grantOf({ capabilities: ['read'] } as unknown as In)).toBeNull();
    expect(grantOf({ namespaces: [], capabilities: ['read'] } as unknown as In)).toBeNull();
  });

  it('returns NULL for an identity that claims nothing — NOT an empty grant', () => {
    // This is the direct-call/system-actor population. An empty object here
    // would refuse every one of them at the engine gate.
    expect(grantOf({ id: 'system' } as Record<string, unknown>)).toBeNull();
    expect(grantOf({})).toBeNull();
    expect(grantOf(undefined)).toBeNull();
    expect(grantOf(null)).toBeNull();
  });

  it('survives junk in the grant rather than throwing', () => {
    expect(grantOf({ grants: { tasks: 'not-an-array' } })).toEqual({ tasks: [] });
    // A malformed grant must FAIL CLOSED. An array resolves to a table whose
    // only keys are indices, so no real namespace matches and every gate
    // refuses. Returning `null` here would read as "no claim" and PASS.
    expect(grantOf({ grants: ['read'] })).toEqual({ '0': [] });
    expect(grantedIn(grantOf({ grants: ['read'] }), 'tasks')).toEqual([]);
    expect(grantOf({ grants: [] })).toEqual({});
  });
});

describe('grantedIn — explicit entry beats the wildcard', () => {
  it('prefers the explicit namespace over the wildcard', () => {
    const grant = { '*': ['read'], tasks: ['read', 'mutate'] };
    expect(grantedIn(grant, 'tasks')).toEqual(['read', 'mutate']);
    expect(grantedIn(grant, 'notes')).toEqual(['read']);
  });

  it('is empty for a null grant and for an unlisted namespace', () => {
    expect(grantedIn(null, 'tasks')).toEqual([]);
    expect(grantedIn({ tasks: ['read'] }, 'notes')).toEqual([]);
  });
});

describe('confersAnywhere — the widest reading, for the one caller that needs it', () => {
  it('is true when ANY namespace confers it', () => {
    expect(confersAnywhere({ notes: ['read'], tasks: ['admin'] }, 'admin')).toBe(true);
  });

  it('is NOT an answer to "what am I granted here"', () => {
    // The distinction the route gate cannot make and the engine gate must.
    const grant = { notes: ['read'], tasks: ['read', 'admin'] };
    expect(confersAnywhere(grant, 'admin')).toBe(true);
    expect(grantedIn(grant, 'notes')).not.toContain('admin');
  });

  it('is false for a null grant — a caller conferring nothing gets nothing', () => {
    expect(confersAnywhere(null, 'read')).toBe(false);
  });
});

describe('an empty explicit entry under a wildcard', () => {
  const shadowed = grantOf({ grants: { '*': ['mutate'], notes: [] } });

  it('grants nothing in that namespace — it does not fall back to the wildcard', () => {
    expect(grantedIn(shadowed, 'notes')).toEqual([]);
    expect(grantedIn(shadowed, 'tasks')).toEqual(['mutate']);
  });

  it('confersAnywhere is unaffected by the empty entry', () => {
    expect(confersAnywhere(shadowed, 'mutate')).toBe(true);
    expect(confersAnywhere(shadowed, 'read')).toBe(false);
  });
});

// A grant is a lookup table, not an object with a prototype. A
// namespace named like an Object.prototype member must read as absent.
describe('prototype-named namespaces read as absent', () => {
  const PROTO = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

  it('grantedIn returns [] and coversNamespace false for them, with no wildcard', () => {
    const g = grantOf({ grants: { notes: ['read'] } });
    for (const ns of PROTO) {
      expect(grantedIn(g, ns)).toEqual([]);
      expect(coversNamespace(g, ns)).toBe(false);
    }
  });

  it('the wildcard still applies to them, as to any unlisted namespace', () => {
    const g = grantOf({ grants: { '*': ['read'] } });
    for (const ns of PROTO) {
      expect(grantedIn(g, ns)).toEqual(['read']);
      expect(coversNamespace(g, ns)).toBe(true);
    }
  });

  it('a hand-built plain-object grant is guarded too', () => {
    const g: IdentityGrant = { notes: ['read'] };
    expect(grantedIn(g, 'toString')).toEqual([]);
    expect(coversNamespace(g, 'constructor')).toBe(false);
  });

  it('a `__proto__` grant key is stored as data, never as the prototype', () => {
    const g = grantOf({ grants: JSON.parse('{"__proto__":["admin"],"notes":["read"]}') });
    expect(grantedIn(g, '__proto__')).toEqual(['admin']);
    expect(grantedIn(g, 'other')).toEqual([]);
    expect(confersAnywhere(g, 'admin')).toBe(true);
    expect(Object.getPrototypeOf(g)).toBe(null);
  });
});
