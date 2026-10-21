import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/candidate-selection.js';
import { buildClusterSurface } from '../src/cluster-frame-surface.js';
import { DEFAULT_CRYSTALLISE_CONFIG } from '../src/crystallise-core.js';
import { CRYSTALLISE_IN_FLIGHT_CODE, createCrystalliseGuard } from '../src/crystallise-guard.js';
import { crystalliseRouteHandler } from '../src/crystallise-route.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';

const MODEL = 'fake:3';

const CANDIDATES: Candidate[] = [
  {
    namespace: 'cortext',
    type: 'Decision',
    id: 'a1',
    vector: new Float32Array([1, 0, 0]),
    row: { title: 'plugin loader' }
  },
  {
    namespace: 'cortext',
    type: 'Decision',
    id: 'a2',
    vector: new Float32Array([0.98, 0.1, 0]),
    row: { title: 'plugin tier' }
  }
];

function fakeEmbeddings(): EmbeddingsStore {
  return {
    txScopeId: 'fake',
    upsert: async (): Promise<void> => {},
    knnSearch: async (): Promise<never[]> => [],
    boostSalience: async (): Promise<[]> => [],
    fetchEmbeddings: async (): Promise<never[]> => [],
    selectCandidates: async (): Promise<Candidate[]> => CANDIDATES.map((c) => ({ ...c }))
  } as unknown as EmbeddingsStore;
}

/** A `runClusterer` that hangs until the caller releases it. */
function blockingClusterer(): {
  runClusterer: (v: readonly Float32Array[]) => Promise<number[]>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    runClusterer: async (v: readonly Float32Array[]): Promise<number[]> => {
      await gate;
      return v.map(() => 0);
    },
    release
  };
}

const post = (body: unknown) =>
  ({ body: Buffer.from(JSON.stringify(body)), identity: null }) as never;

const SELECT = { mode: 'form', select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] } };

describe('createCrystalliseGuard', () => {
  it('lets a call through when nothing is in flight', async () => {
    const guard = createCrystalliseGuard();
    const result = await guard.runExclusive(async () => 42);
    expect(result).toBe(42);
  });

  it('refuses a concurrent call with a coded crystallise_in_flight error', async () => {
    const guard = createCrystalliseGuard();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = guard.runExclusive(async () => {
      await gate;
      return 'first';
    });

    await expect(guard.runExclusive(async () => 'second')).rejects.toMatchObject({
      code: CRYSTALLISE_IN_FLIGHT_CODE
    });

    release();
    await expect(first).resolves.toBe('first');
  });

  it('releases the lock even when the wrapped call throws', async () => {
    const guard = createCrystalliseGuard();
    await expect(
      guard.runExclusive(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // The lock must have been released — a fresh call succeeds immediately.
    await expect(guard.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('allows a new call once the prior one has completed', async () => {
    const guard = createCrystalliseGuard();
    await guard.runExclusive(async () => 'first');
    await expect(guard.runExclusive(async () => 'second')).resolves.toBe('second');
  });
  // The cross-process layer (a pg advisory lock in production).
  it('runs the call inside the cross-process lock when one is supplied', async () => {
    const order: string[] = [];
    const guard = createCrystalliseGuard({
      crossProcess: async (fn) => {
        order.push('lock');
        try {
          return await fn();
        } finally {
          order.push('unlock');
        }
      }
    });
    await guard.runExclusive(async () => {
      order.push('fn');
    });
    expect(order).toEqual(['lock', 'fn', 'unlock']);
  });

  it('a cross-process refusal surfaces as-is and clears the local flag', async () => {
    let otherProcessHolds = true;
    const guard = createCrystalliseGuard({
      crossProcess: async (fn) => {
        if (otherProcessHolds) {
          throw Object.assign(new Error('held elsewhere'), { code: CRYSTALLISE_IN_FLIGHT_CODE });
        }
        return fn();
      }
    });
    await expect(guard.runExclusive(async () => 'x')).rejects.toMatchObject({
      code: CRYSTALLISE_IN_FLIGHT_CODE
    });
    // A refusal from the other process must not wedge THIS one.
    otherProcessHolds = false;
    await expect(guard.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('shared guard spans both crystallise transports', () => {
  it('a frame call in flight refuses a concurrent ROUTE call — not just frame-vs-frame', async () => {
    const guard = createCrystalliseGuard();
    const blocker = blockingClusterer();

    const surface = buildClusterSurface({
      embeddings: fakeEmbeddings(),
      clusters: new InMemoryClusterStore({ txScopeId: 'mem-frame' }),
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG,
      runClusterer: blocker.runClusterer,
      guard
    });
    const route = crystalliseRouteHandler({
      embeddings: fakeEmbeddings(),
      clusters: new InMemoryClusterStore({ txScopeId: 'mem-route' }),
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG,
      guard
    });

    const frameCall = surface.mutations.crystallise.resolver({ identity: null } as never, {
      params: SELECT
    });

    // Give the frame call a tick to reach and hold the guard before racing the route.
    await Promise.resolve();

    const routeRes = await route(post(SELECT));
    expect(routeRes.status).toBe(409);
    const body = JSON.parse(
      Buffer.isBuffer(routeRes.body) ? routeRes.body.toString('utf8') : String(routeRes.body)
    ) as { error: { code: string } };
    expect(body.error.code).toBe(CRYSTALLISE_IN_FLIGHT_CODE);

    blocker.release();
    await expect(frameCall).resolves.toMatchObject({ mode: 'form' });
  });

  it('a route call in flight refuses a concurrent FRAME call — not just route-vs-route', async () => {
    const guard = createCrystalliseGuard();
    const blocker = blockingClusterer();

    const route = crystalliseRouteHandler({
      embeddings: fakeEmbeddings(),
      clusters: new InMemoryClusterStore({ txScopeId: 'mem-route-2' }),
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG,
      runClusterer: blocker.runClusterer,
      guard
    });
    const surface = buildClusterSurface({
      embeddings: fakeEmbeddings(),
      clusters: new InMemoryClusterStore({ txScopeId: 'mem-frame-2' }),
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG,
      guard
    });

    const routeCall = route(post(SELECT));
    await Promise.resolve();

    await expect(
      surface.mutations.crystallise.resolver({ identity: null } as never, { params: SELECT })
    ).rejects.toMatchObject({ code: CRYSTALLISE_IN_FLIGHT_CODE });

    blocker.release();
    const routeRes = await routeCall;
    expect(routeRes.status).toBe(200);
  });
});
