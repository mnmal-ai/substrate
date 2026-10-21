import type { Identity, Policy, RequestContext, ResolverArgs } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import {
  allowAll,
  allowVerbs,
  and,
  applyRowFilters,
  denyAll,
  denyVerbs,
  not,
  or,
  requireCapability,
  requireIdentity,
  row
} from '../src/index.js';

// --- test fixtures ----------------------------------------------------------

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    identity: null,
    namespace: 'test',
    operation: 'query',
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

const identity: Identity = { id: 'alice', grants: {} };
const emptyArgs: ResolverArgs = {};

const boom: Policy = () => {
  throw new Error('kaboom');
};

// --- primitives -------------------------------------------------------------

describe('allowAll', () => {
  it('returns { allow: true }', () => {
    expect(allowAll()(makeCtx(), emptyArgs)).toEqual({ allow: true });
  });
});

describe('denyAll', () => {
  it("defaults to reason 'denyAll'", () => {
    expect(denyAll()(makeCtx(), emptyArgs)).toEqual({ allow: false, reason: 'denyAll' });
  });

  it('uses supplied reason when provided', () => {
    expect(denyAll('nope')(makeCtx(), emptyArgs)).toEqual({ allow: false, reason: 'nope' });
  });
});

describe('requireIdentity', () => {
  it('allows when identity is set', () => {
    expect(requireIdentity()(makeCtx({ identity }), emptyArgs)).toEqual({ allow: true });
  });

  it('denies with a descriptive reason when identity is null', () => {
    expect(requireIdentity()(makeCtx(), emptyArgs)).toEqual({
      allow: false,
      reason: 'requireIdentity: no identity'
    });
  });
});

// --- and --------------------------------------------------------------------

describe('and', () => {
  it('empty and() returns allow (identity element)', () => {
    expect(and()(makeCtx(), emptyArgs)).toEqual({ allow: true });
  });

  it('allows when every policy allows', () => {
    expect(and(allowAll(), allowAll())(makeCtx(), emptyArgs)).toEqual({ allow: true });
  });

  it("short-circuits on first deny and surfaces that deny's reason", () => {
    const later = vi.fn<Policy>(() => ({ allow: true }));
    const decision = and(denyAll('stop'), later)(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false, reason: 'stop' });
    expect(later).not.toHaveBeenCalled();
  });

  it("converts a throwing inner policy to deny with reason 'policy error'", () => {
    const later = vi.fn<Policy>(() => ({ allow: true }));
    const decision = and(boom, later)(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false, reason: 'policy error' });
    expect(later).not.toHaveBeenCalled();
  });
});

// --- or ---------------------------------------------------------------------

describe('or', () => {
  it("empty or() denies with reason 'or(): no policies'", () => {
    expect(or()(makeCtx(), emptyArgs)).toEqual({
      allow: false,
      reason: 'or(): no policies'
    });
  });

  it('short-circuits on first allow; later policies are not invoked', () => {
    const later = vi.fn<Policy>(() => ({ allow: false, reason: 'never reached' }));
    const decision = or(allowAll(), later)(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: true });
    expect(later).not.toHaveBeenCalled();
  });

  it("surfaces the LAST deny's reason when all deny", () => {
    const decision = or(denyAll('first'), denyAll('middle'), denyAll('last'))(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false, reason: 'last' });
  });

  it("caught 'policy error' wins over sibling deny reasons", () => {
    // Spec §4.4: or(boom, denyAll) returns 'policy error', NOT 'denyAll'.
    const decision = or(boom, denyAll('X'))(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false, reason: 'policy error' });
  });

  it("caught error anywhere in the chain wins even when it isn't the last to run", () => {
    const decision = or(denyAll('first'), boom, denyAll('third'))(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false, reason: 'policy error' });
  });
});

// --- not --------------------------------------------------------------------

describe('not', () => {
  it('not(allow-with-no-reason) returns { allow: false } with no reason key', () => {
    const decision = not(allowAll())(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false });
    expect('reason' in decision).toBe(false);
  });

  it("not(deny) flips to allow and preserves the inner deny's reason", () => {
    const decision = not(denyAll('inner'))(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: true, reason: 'inner' });
  });

  it("not(throwing) stays denied with 'policy error' (does NOT invert caught errors)", () => {
    const decision = not(boom)(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: false, reason: 'policy error' });
  });
});

// --- row --------------------------------------------------------------------

interface Price {
  id: number;
  ownerId: string;
}

describe('row', () => {
  it('always allows at collection-time with exactly one row-filter obligation', () => {
    const policy = row<Price>((_ctx, p) => p.ownerId === 'alice');
    const decision = policy(makeCtx({ identity }), emptyArgs);
    expect(decision.allow).toBe(true);
    expect(decision.obligations).toHaveLength(1);
    expect(decision.obligations?.[0]?.kind).toBe('row-filter');
    expect(typeof (decision.obligations![0] as { predicate?: unknown }).predicate).toBe('function');
  });

  it('composes with requireIdentity via and: allow + one obligation', () => {
    const policy = and(
      requireIdentity(),
      row<Price>((_ctx, p) => p.ownerId === 'alice')
    );
    const decision = policy(makeCtx({ identity }), emptyArgs);
    expect(decision.allow).toBe(true);
    expect(decision.obligations).toHaveLength(1);
  });
});

describe('obligation accumulation', () => {
  it('and(row(pA), row(pB)) → allow with both obligations in order', () => {
    const pA = (_ctx: RequestContext, _r: Price) => true;
    const pB = (_ctx: RequestContext, _r: Price) => true;
    const decision = and(row<Price>(pA), row<Price>(pB))(makeCtx(), emptyArgs);
    expect(decision.allow).toBe(true);
    expect(decision.obligations).toHaveLength(2);
    expect((decision.obligations![0] as { predicate?: unknown }).predicate).toBe(pA);
    expect((decision.obligations![1] as { predicate?: unknown }).predicate).toBe(pB);
  });

  it('or(row, denyAll) → winner (row) obligations only', () => {
    const pA = (_ctx: RequestContext, _r: Price) => true;
    const decision = or(row<Price>(pA), denyAll())(makeCtx(), emptyArgs);
    expect(decision.allow).toBe(true);
    expect(decision.obligations).toHaveLength(1);
    expect((decision.obligations![0] as { predicate?: unknown }).predicate).toBe(pA);
  });

  it('or(denyAll, row) short-circuits on row allow; only row obligations carried', () => {
    const pA = (_ctx: RequestContext, _r: Price) => true;
    const decision = or(denyAll(), row<Price>(pA))(makeCtx(), emptyArgs);
    expect(decision.allow).toBe(true);
    expect(decision.obligations).toHaveLength(1);
    expect((decision.obligations![0] as { predicate?: unknown }).predicate).toBe(pA);
  });

  it('and() with only allowAlls emits no obligations key (empty arrays omitted)', () => {
    const decision = and(allowAll(), allowAll())(makeCtx(), emptyArgs);
    expect(decision).toEqual({ allow: true });
    expect('obligations' in decision).toBe(false);
  });
});

// --- applyRowFilters --------------------------------------------------------

describe('applyRowFilters', () => {
  const rows: Price[] = [
    { id: 1, ownerId: 'alice' },
    { id: 2, ownerId: 'bob' },
    { id: 3, ownerId: 'alice' }
  ];

  it('returns rows unchanged when the decision has no obligations', () => {
    expect(applyRowFilters({ allow: true }, rows, makeCtx())).toEqual(rows);
  });

  it('applies predicates in insertion order (composed via and)', () => {
    const order: string[] = [];
    const keepAlice = row<Price>((_ctx, r) => {
      order.push('alice');
      return r.ownerId === 'alice';
    });
    const keepOdd = row<Price>((_ctx, r) => {
      order.push('odd');
      return r.id % 2 === 1;
    });
    const decision = and(keepAlice, keepOdd)(makeCtx(), emptyArgs);
    const filtered = applyRowFilters<Price>(decision, rows, makeCtx());
    expect(filtered).toEqual([
      { id: 1, ownerId: 'alice' },
      { id: 3, ownerId: 'alice' }
    ]);
    // First pass runs alice on all 3 rows; second pass runs odd on the 2
    // survivors. The exact sequence proves insertion order.
    expect(order).toEqual(['alice', 'alice', 'alice', 'odd', 'odd']);
  });

  it('silently drops rows when a predicate throws', () => {
    const throwOnBob = row<Price>((_ctx, r) => {
      if (r.ownerId === 'bob') throw new Error('nope');
      return true;
    });
    const decision = throwOnBob(makeCtx(), emptyArgs);
    const filtered = applyRowFilters<Price>(decision, rows, makeCtx());
    expect(filtered).toEqual([
      { id: 1, ownerId: 'alice' },
      { id: 3, ownerId: 'alice' }
    ]);
  });
});

describe('denyVerbs / allowVerbs', () => {
  it('denyVerbs denies a matching verb and surfaces it in the reason', () => {
    const p = denyVerbs(['delete']);
    const d = p(makeCtx({ operation: 'mutate', entry: 'deleteTodo', verb: 'delete' }), emptyArgs);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('delete');
  });

  it('denyVerbs allows non-matching verbs and verbless dispatches', () => {
    const p = denyVerbs(['delete']);
    expect(
      p(makeCtx({ operation: 'mutate', entry: 'getTodo', verb: 'get' }), emptyArgs).allow
    ).toBe(true);
    // Type entries / custom mutations carry no verb — denyVerbs passes them.
    expect(p(makeCtx({ operation: 'query', entry: 'Todo' }), emptyArgs).allow).toBe(true);
    expect(p(makeCtx({ operation: 'mutate', entry: 'customNuke' }), emptyArgs).allow).toBe(true);
  });

  it('allowVerbs passes listed verbs and DENIES verbless dispatches (strict allow-list)', () => {
    const p = allowVerbs(['get', 'create']);
    expect(p(makeCtx({ operation: 'mutate', verb: 'get' }), emptyArgs).allow).toBe(true);
    expect(p(makeCtx({ operation: 'mutate', verb: 'delete' }), emptyArgs).allow).toBe(false);
    const verbless = p(makeCtx({ operation: 'mutate', entry: 'customNuke' }), emptyArgs);
    expect(verbless.allow).toBe(false);
    expect(verbless.reason).toContain('customNuke');
  });

  it('composes: and(requireIdentity(), denyVerbs([delete])) — both must pass', () => {
    const p = and(requireIdentity(), denyVerbs(['delete']));
    expect(p(makeCtx({ identity, verb: 'get' }), emptyArgs).allow).toBe(true);
    expect(p(makeCtx({ identity, verb: 'delete' }), emptyArgs).allow).toBe(false);
    expect(p(makeCtx({ verb: 'get' }), emptyArgs).allow).toBe(false);
  });
});

/**
 * `requireCapability` is namespace-aware (spec §8.2).
 *
 * For frames dispatched through the engine it is defence-in-depth — the
 * per-frame gate runs first — but for `purge<T>`, whose admin gate is evaluated
 * in the namespace of the type being purged, it IS the gate: `admin` in one
 * namespace must not purge a type in another.
 */
describe('requireCapability is namespace-aware', () => {
  const ctxIn = (namespace: string, identity: unknown): never =>
    ({ namespace, identity, operation: 'mutate', now: new Date(), headers: {}, meta: {} }) as never;

  const granted = { id: 'a', grants: { board: ['read'], journal: ['read', 'mutate'] } };

  it('allows where the grant confers it in THIS namespace', () => {
    expect(requireCapability('mutate')(ctxIn('journal', granted), emptyArgs).allow).toBe(true);
  });

  it('REFUSES where the grant is narrower in this namespace', () => {
    expect(requireCapability('mutate')(ctxIn('board', granted), emptyArgs).allow).toBe(false);
  });

  it('refuses a namespace the grant does not name', () => {
    expect(requireCapability('read')(ctxIn('tasks', granted), emptyArgs).allow).toBe(false);
  });

  it('an EMPTY explicit entry under a wildcard refuses — it is a shadow, not a gap', () => {
    const shadowed = { id: 'a', grants: { '*': ['read', 'mutate', 'admin'], _system: [] } };
    expect(requireCapability('admin')(ctxIn('_system', shadowed), emptyArgs).allow).toBe(false);
    expect(requireCapability('read')(ctxIn('_system', shadowed), emptyArgs).allow).toBe(false);
    expect(requireCapability('admin')(ctxIn('journal', shadowed), emptyArgs).allow).toBe(true);
  });

  it('honours a wildcard entry, beaten by an explicit one', () => {
    const wild = { id: 'a', grants: { '*': ['read'], journal: ['read', 'mutate'] } };
    expect(requireCapability('read')(ctxIn('anything', wild), emptyArgs).allow).toBe(true);
    expect(requireCapability('mutate')(ctxIn('anything', wild), emptyArgs).allow).toBe(false);
    expect(requireCapability('mutate')(ctxIn('journal', wild), emptyArgs).allow).toBe(true);
  });

  // No grant means no claim means REFUSE. Flat fields are ignored, not honored.
  it('refuses when there is no grant, even with flat capabilities present', () => {
    const flat = { id: 'a', capabilities: ['read', 'mutate'] } as unknown as Identity;
    expect(requireCapability('mutate')(ctxIn('anywhere', flat), emptyArgs).allow).toBe(false);
    expect(requireCapability('admin')(ctxIn('anywhere', flat), emptyArgs).allow).toBe(false);
  });

  it('still refuses when there is no identity at all', () => {
    expect(requireCapability('read')(ctxIn('journal', null), emptyArgs).allow).toBe(false);
  });
});

// ---- auth-disabled naming ----
//
// `policy_denied: no identity` reads as "my credential is wrong" when the real
// cause is that the server verifies nothing, so refusals must name it.

describe('refusals name auth being DISABLED, when the transport said so', () => {
  it('requireIdentity: names it, and names the fix', () => {
    const d = requireIdentity()(makeCtx({ authEnabled: false }), emptyArgs);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/auth DISABLED/);
    expect(d.reason).toMatch(/SUBSTRATE_AUTH_MODE/);
  });

  it('requireCapability: same, and still names the capability', () => {
    const d = requireCapability('admin')(makeCtx({ authEnabled: false }), emptyArgs);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/requireCapability\(admin\)/);
    expect(d.reason).toMatch(/auth DISABLED/);
  });

  it('says NOTHING about auth when the transport did not tell us — a guess here is the same bug inverted', () => {
    const d = requireIdentity()(makeCtx(), emptyArgs);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('requireIdentity: no identity');
  });

  it('stays silent when auth IS enabled — the credential really is the problem then', () => {
    const d = requireIdentity()(makeCtx({ authEnabled: true }), emptyArgs);
    expect(d.reason).toBe('requireIdentity: no identity');
  });

  it('an identity that IS present is unaffected by the flag', () => {
    expect(requireIdentity()(makeCtx({ identity, authEnabled: false }), emptyArgs)).toEqual({
      allow: true
    });
  });
});
