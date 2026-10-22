/**
 * Subscription dispatch-path conformance for identity-keyed row-filter
 * obligations (the contract addressed-event visibility builds on).
 *
 * The contract under test, end to end:
 *   - the type entry's policy is evaluated at subscribe registration with the
 *     subscriber's identity; a deny refuses registration (`policy_denied`);
 *   - row-filter obligations redact the snapshot;
 *   - the SAME obligations + subscriber ctx are re-applied to every live
 *     push, so a row the policy would redact at query time is also withheld
 *     from pushes;
 *   - visibility transitions are tracked per subscriber: a row retargeted
 *     away emits `remove` only for subscribers that previously saw it, and a
 *     row that was never visible leaves no trace (no add, no remove) —
 *     counterfactual indistinguishability for addressed events.
 *
 * Mechanism: `engine/subscribe.ts` stores `decision.obligations` + the
 * subscriber ctx on the SubscriptionEntry and gates `#emitToSubscription`
 * through `obligationsPermitRow`.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row } from '@mnmal-ai/substrate-policy';
import type {
  Policy,
  RequestContext,
  Resolver,
  Row,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NOW = (): Date => new Date('2026-06-10T00:00:00Z');
const NS = 'cohort';

const SELF_A = 'self-a@host';
const SELF_B = 'self-b@host';

interface EventRow extends Row {
  toSystem: string;
}

function ctxFor(kid: string | null): Partial<RequestContext> {
  return {
    identity: kid === null ? null : { id: kid, grants: { '*': ['read', 'mutate'] } },
    now: NOW()
  };
}

/**
 * cohort/Event lookalike: rows live in a Map; create/retarget mutations write
 * the Map and announce via args.onWrite (the engine fans the WriteEvent out to
 * subscriptions post-commit). The type policy is an addressing rule:
 * identity required, row visible iff toSystem ∈ { identity.id, '*' }.
 */
function buildEngine(): { engine: Engine; seed: (rows: EventRow[]) => void } {
  const store = new Map<string, EventRow>();

  const visibility: Policy = (ctx, args) => {
    if (ctx.identity === null) {
      return { allow: false, reason: 'cohort/Event requires an authenticated identity' };
    }
    return row<EventRow>((c, r) => r.toSystem === c.identity?.id || r.toSystem === '*')(ctx, args);
  };

  const list: Resolver = async () => [...store.values()];
  const create: Resolver = async (_ctx, args) => {
    const params = args.params ?? {};
    const r: EventRow = { id: String(params.id), toSystem: String(params.toSystem) };
    store.set(String(r.id), r);
    args.onWrite?.({ ns: NS, type: 'Event', id: r.id, operation: 'create', row: r });
    return r;
  };
  const retarget: Resolver = async (_ctx, args) => {
    const params = args.params ?? {};
    const existing = store.get(String(params.id));
    if (existing === undefined) return null;
    const r: EventRow = { ...existing, toSystem: String(params.toSystem) };
    store.set(String(r.id), r);
    args.onWrite?.({ ns: NS, type: 'Event', id: r.id, operation: 'update', row: r });
    return r;
  };

  const registry = new Registry();
  registry.register('Event', { resolver: list, policy: visibility });
  registry.register('createEvent', { kind: 'mutation', resolver: create });
  registry.register('retargetEvent', { kind: 'mutation', resolver: retarget });

  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, new MemoryDataset({ namespace: NS }));
  const engine = new Engine({
    namespaces: new Map([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: NOW })
  });
  return {
    engine,
    seed: (rows): void => {
      for (const r of rows) store.set(String(r.id), r);
    }
  };
}

interface Collector {
  frames: WsResponseFrame[];
  onFrame: (f: WsResponseFrame) => void;
}

function collector(): Collector {
  const frames: WsResponseFrame[] = [];
  return { frames, onFrame: (f): void => void frames.push(f) };
}

/** Frame delivery is enqueue + lazy drain — poll until quiescent. */
async function settled<T>(probe: () => T, want: (v: T) => boolean, ms = 500): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (want(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function subscribeAs(engine: Engine, id: string, kid: string | null): Promise<Collector> {
  const c = collector();
  await engine.subscribe({
    id,
    frame: { [`${NS}/Event`]: { params: {}, fields: { id: true, toSystem: true } } },
    ctx: ctxFor(kid),
    onFrame: c.onFrame
  });
  return c;
}

function pushKinds(c: Collector): Array<{ kind: string; id?: unknown }> {
  return c.frames
    .filter((f) => f.kind !== 'snapshot')
    .map((f) => ({
      kind: f.kind,
      id:
        f.kind === 'remove'
          ? f.removedId
          : (f.data as Record<string, EventRow> | undefined)?.[`${NS}/Event`]?.id
    }));
}

describe('subscription row-filter obligations: a rule that throws', () => {
  it('withholds the pushed row and the committed mutate still succeeds', async () => {
    const store = new Map<string, Row>();
    const registry = new Registry();
    registry.register('Event', {
      resolver: async () => [...store.values()],
      policy: row<{ owner?: { id: string } }>((c, r) => r.owner!.id === c.identity?.id)
    });
    registry.register('createEvent', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        const r: Row = { id: String(args.params?.id) };
        store.set(String(r.id), r);
        args.onWrite?.({ ns: NS, type: 'Event', id: r.id, operation: 'create', row: r });
        return r;
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, new MemoryDataset({ namespace: NS }));
    const engine = new Engine({
      namespaces: new Map([[NS, { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });
    const a = await subscribeAs(engine, 'sub-a', SELF_A);

    // The row has no owner, so the rule throws on the push.
    const result = await engine.mutate({
      frame: { [`${NS}/createEvent`]: { params: { id: 'e1' }, fields: { id: true } } },
      ctx: ctxFor(SELF_A)
    });

    expect(result.errors ?? []).toEqual([]);
    expect(store.has('e1')).toBe(true);
    expect(pushKinds(a)).toEqual([]);
  });
});

describe('subscription row-filter obligations (identity-keyed)', () => {
  it('redacts the snapshot per subscriber identity', async () => {
    const { engine, seed } = buildEngine();
    seed([
      { id: 'e1', toSystem: SELF_A },
      { id: 'e2', toSystem: SELF_B },
      { id: 'e3', toSystem: '*' }
    ]);

    const a = await subscribeAs(engine, 'sub-a', SELF_A);
    const snapshot = a.frames[0];
    expect(snapshot?.kind).toBe('snapshot');
    const rows = ((snapshot?.data as Record<string, EventRow[]> | undefined)?.[`${NS}/Event`] ??
      []) as EventRow[];
    expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'e3']);
  });

  it('refuses an anonymous subscriber at registration (policy_denied)', async () => {
    const { engine } = buildEngine();
    const c = await subscribeAs(engine, 'sub-anon', null);
    expect(c.frames[0]?.kind).toBe('error');
    expect(c.frames[0]?.errors?.[0]?.code).toBe('policy_denied');
  });

  it('withholds a directed create from non-addressees — no frame at all', async () => {
    const { engine } = buildEngine();
    const a = await subscribeAs(engine, 'sub-a', SELF_A);
    const b = await subscribeAs(engine, 'sub-b', SELF_B);

    await engine.mutate({
      frame: { [`${NS}/createEvent`]: { params: { id: 'e1', toSystem: SELF_A }, fields: {} } },
      ctx: ctxFor(SELF_A)
    });

    await settled(
      () => pushKinds(a).length,
      (n) => n >= 1
    );
    expect(pushKinds(a)).toEqual([{ kind: 'add', id: 'e1' }]);
    // B never sees the row exist — counterfactual indistinguishability.
    expect(pushKinds(b)).toEqual([]);
  });

  it("delivers a '*' broadcast to every subscriber", async () => {
    const { engine } = buildEngine();
    const a = await subscribeAs(engine, 'sub-a', SELF_A);
    const b = await subscribeAs(engine, 'sub-b', SELF_B);

    await engine.mutate({
      frame: { [`${NS}/createEvent`]: { params: { id: 'e1', toSystem: '*' }, fields: {} } },
      ctx: ctxFor(SELF_A)
    });

    await settled(
      () => pushKinds(a).length + pushKinds(b).length,
      (n) => n >= 2
    );
    expect(pushKinds(a)).toEqual([{ kind: 'add', id: 'e1' }]);
    expect(pushKinds(b)).toEqual([{ kind: 'add', id: 'e1' }]);
  });

  it('retargeting emits remove for the old addressee and add for the new one', async () => {
    const { engine } = buildEngine();
    const a = await subscribeAs(engine, 'sub-a', SELF_A);
    const b = await subscribeAs(engine, 'sub-b', SELF_B);

    await engine.mutate({
      frame: { [`${NS}/createEvent`]: { params: { id: 'e1', toSystem: SELF_A }, fields: {} } },
      ctx: ctxFor(SELF_A)
    });
    await settled(
      () => pushKinds(a).length,
      (n) => n >= 1
    );

    await engine.mutate({
      frame: { [`${NS}/retargetEvent`]: { params: { id: 'e1', toSystem: SELF_B }, fields: {} } },
      ctx: ctxFor(SELF_A)
    });
    await settled(
      () => pushKinds(a).length + pushKinds(b).length,
      (n) => n >= 3
    );

    expect(pushKinds(a)).toEqual([
      { kind: 'add', id: 'e1' },
      { kind: 'remove', id: 'e1' }
    ]);
    // B sees the row appear on retarget — and nothing before it.
    expect(pushKinds(b)).toEqual([{ kind: 'add', id: 'e1' }]);
  });

  it('an update that keeps a row invisible to a subscriber emits nothing for them', async () => {
    const { engine } = buildEngine();
    const b = await subscribeAs(engine, 'sub-b', SELF_B);

    await engine.mutate({
      frame: { [`${NS}/createEvent`]: { params: { id: 'e1', toSystem: SELF_A }, fields: {} } },
      ctx: ctxFor(SELF_A)
    });
    // Retarget between two identities that are both ≠ B.
    await engine.mutate({
      frame: {
        [`${NS}/retargetEvent`]: { params: { id: 'e1', toSystem: 'self-c@host' }, fields: {} }
      },
      ctx: ctxFor(SELF_A)
    });

    // Give the drain a beat, then assert silence end-to-end.
    await new Promise((r) => setTimeout(r, 25));
    expect(pushKinds(b)).toEqual([]);
  });
});
