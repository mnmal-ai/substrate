/**
 * §5.13 batched mutate (array-valued op-keys).
 *
 * Contract:
 *   - Same op-key, array of N frames → all N run serially inside ONE
 *     transaction; all-or-nothing per op-key (atomic within-key).
 *   - Cross-op-key atomicity is NOT a goal for the batched path: each array
 *     op-key commits in its OWN isolated tx, independent of every other
 *     op-key (including the single-frame G1 bucket).
 *   - Per-frame idempotency dedup: `FrameEntry.idempotencyKey` on an array
 *     element is keyed on `(op-key, index, idempotencyKey)` — a replay hits
 *     the cache for that slot and skips the resolver without re-running the
 *     whole array.
 *   - Envelope shape: `data[key]` is `Array<unknown>` with one slot per
 *     frame; `shapes[key]` is `Array<'single' | 'list'>` with the per-frame
 *     shape at each index.
 *   - Empty array (`[]`) is a caller bug and is rejected with
 *     `empty_frame_array`.
 *   - Array values on query / subscribe / stream dispatch paths are
 *     rejected with `batched_not_supported`.
 *   - Batched forwarding across bridges is not supported; a bridged array
 *     op-key surfaces `bridge_array_not_supported`.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  BridgeClient,
  BridgeRegistry,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  MemoryIdempotencyStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '../src/index.js';

function makeEdges(nowMs = Date.parse('2026-04-18T00:00:00Z')): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date(nowMs) });
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: null,
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

interface Bootstrapped {
  engine: Engine;
  dataset: MemoryDataset;
  registry: Registry;
  metrics: Array<{ name: string; payload: unknown }>;
}

/**
 * Per-test engine wired with a fresh Registry so each test owns its own
 * mutation surface. Auto-CRUD is intentionally NOT installed — the batched
 * path is exercised through hand-rolled mutation resolvers so every
 * assertion targets the engine, not the SDK wrapper.
 */
function bootstrap(opts: { idempotency?: boolean; bridges?: BridgeRegistry } = {}): Bootstrapped {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const registry = new Registry();
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const metrics: Array<{ name: string; payload: unknown }> = [];

  const engine = new Engine({
    namespaces,
    datasets,
    edges: makeEdges(),
    metric: (name, payload) => {
      metrics.push({ name, payload });
    },
    ...(opts.idempotency === true ? { idempotency: { store: new MemoryIdempotencyStore() } } : {}),
    ...(opts.bridges !== undefined ? { sweepHooks: { bridges: opts.bridges } } : {})
  });
  return { engine, dataset, registry, metrics };
}

/**
 * Writes one Todo using the engine-threaded tx dataset. Mirrors the helper
 * in `engine.test.ts` — same contract (resolver MUST use `args.dataset` so
 * the G1 / batched-array rollback is observable).
 */
const createTodoResolver: Resolver = async (_ctx, args) => {
  const params = (args.params ?? {}) as { id?: string; title?: string };
  if (!args.dataset) throw new Error('expected engine-injected args.dataset');
  const id = params.id ?? 'auto';
  const row: Row = { id, title: params.title ?? '' };
  await args.dataset.write('Todo', [row]);
  return row;
};

describe('§5.13 batched mutate — array-valued op-keys', () => {
  it('commits all frames under one op-key and returns an array envelope', async () => {
    const { engine, dataset, registry } = bootstrap();
    registry.register('createTodo', { kind: 'mutation', resolver: createTodoResolver });

    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': [
          { params: { id: 't1', title: 'one' } },
          { params: { id: 't2', title: 'two' } },
          { params: { id: 't3', title: 'three' } }
        ]
      },
      ctx: makeCtx()
    });

    expect(envelope.errors).toBeUndefined();
    const data = envelope.data['default/createTodo'];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual([
      { id: 't1', title: 'one' },
      { id: 't2', title: 'two' },
      { id: 't3', title: 'three' }
    ]);
    expect(envelope.shapes['default/createTodo']).toEqual(['single', 'single', 'single']);

    const { rows } = await dataset.read('Todo', {});
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('rolls back the whole array when frame[i] throws (atomic within-key)', async () => {
    const { engine, dataset, registry } = bootstrap();
    let callCount = 0;
    const resolver: Resolver = async (_ctx, args) => {
      if (!args.dataset) throw new Error('expected args.dataset');
      const params = (args.params ?? {}) as { id?: string };
      callCount += 1;
      if (params.id === 'boom') throw new Error('frame 1 explodes');
      await args.dataset.write('Todo', [{ id: params.id ?? 'x', title: 'x' }]);
      return { id: params.id } as Row;
    };
    registry.register('createTodo', { kind: 'mutation', resolver });

    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': [
          { params: { id: 't1' } },
          { params: { id: 'boom' } },
          { params: { id: 't3' } }
        ]
      },
      ctx: makeCtx()
    });

    // Array runs serially; index 2 never executes (error at index 1 breaks
    // the loop and unwinds the tx).
    expect(callCount).toBe(2);
    expect(envelope.errors).toBeDefined();
    const err = envelope.errors?.[0];
    expect(err?.code).toBe('batched_frame_rolled_back');
    // The failing frame index surfaces in the error path.
    expect(err?.path).toEqual(['default/createTodo', '1']);
    expect(err?.message).toContain('at frame[1]');
    expect(err?.message).toContain('internal error');
    expect(err?.message).not.toContain('frame 1 explodes');

    // No rows persisted — the tx rolled back cleanly.
    const { rows } = await dataset.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(0);
  });

  // A resolver that refuses via ResolverFrameError (the sanctioned
  // resolver→client channel) does not throw out of `#runEntry` — it is recorded
  // on the envelope and returns normally. The array must still roll back the
  // frames that ran before it.
  it('a ResolverFrameError rolls the whole array back, like any other failure', async () => {
    const { engine, dataset, registry } = bootstrap();
    let callCount = 0;
    const resolver = async (_ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
      callCount += 1;
      const id = String((args.params as { id?: unknown })?.id ?? '');
      if (id === 'refuse') {
        // Exactly how autoCRUD's updateResolver reports a missing row.
        throw new ResolverFrameError('not_found', `no row with id '${id}'`);
      }
      const row: Row = { id };
      await (args.dataset as MemoryDataset).write('Todo', [row], {
        identity: { kind: 'system', id: 'test' },
        now: new Date()
      });
      return row;
    };
    registry.register('createTodo', { kind: 'mutation', resolver });

    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': [{ params: { id: 't1' } }, { params: { id: 'refuse' } }]
      },
      ctx: makeCtx()
    });

    expect(callCount).toBe(2);
    expect(envelope.errors).toBeDefined();

    // The caller-branchable code SURVIVES the rollback — losing it would trade
    // one defect for another, since `not_found` is why ResolverFrameError exists.
    const codes = (envelope.errors ?? []).map((e) => e.code);
    expect(codes).toContain('not_found');

    // The point: frame 0 must NOT have committed.
    const { rows } = await dataset.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(0);
  });

  it('array op-key + single op-key run in INDEPENDENT txs (array throw does not roll back the single)', async () => {
    // §5.13: cross-op-key atomicity is NOT a goal for the batched path.
    // The array op-key's failure must NOT roll back the single op-key's
    // successful commit.
    const { engine, dataset, registry } = bootstrap();
    registry.register('createTodo', { kind: 'mutation', resolver: createTodoResolver });
    registry.register('createBoom', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        const params = (args.params ?? {}) as { id?: string };
        if (params.id === 'fail') throw new Error('array frame dies');
        await args.dataset.write('Todo', [{ id: params.id ?? '?', title: 'boom' }]);
        return { id: params.id } as Row;
      }
    });

    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': { params: { id: 'single-ok', title: 'alive' } },
        'default/createBoom': [{ params: { id: 'arr-1' } }, { params: { id: 'fail' } }]
      },
      ctx: makeCtx()
    });

    // Single op-key succeeded; array op-key rolled back.
    expect(envelope.data['default/createTodo']).toEqual({ id: 'single-ok', title: 'alive' });
    const batchedErr = envelope.errors?.find((e) => e.code === 'batched_frame_rolled_back');
    expect(batchedErr).toBeDefined();

    // Dataset holds only the single op-key's row — nothing from the array.
    const { rows } = await dataset.read('Todo', {});
    expect(rows.map((r) => r.id)).toEqual(['single-ok']);
  });

  it('per-frame idempotency: replaying one slot of a batched array hits the cache (resolver NOT re-run)', async () => {
    const { engine, registry } = bootstrap({ idempotency: true });
    let runs = 0;
    const resolver: Resolver = async (_ctx, args) => {
      runs += 1;
      const params = (args.params ?? {}) as { id?: string };
      if (!args.dataset) throw new Error('expected args.dataset');
      await args.dataset.write('Todo', [{ id: params.id ?? 'x', title: 'x' }]);
      return { id: params.id ?? 'x' } as Row;
    };
    registry.register('createTodo', { kind: 'mutation', resolver });

    const first = await engine.mutate({
      frame: {
        'default/createTodo': [
          { params: { id: 'a' }, idempotencyKey: 'k-a' },
          { params: { id: 'b' } },
          { params: { id: 'c' }, idempotencyKey: 'k-c' }
        ]
      },
      ctx: makeCtx()
    });
    expect(first.errors).toBeUndefined();
    expect(runs).toBe(3);

    // Replay — slot 0 + slot 2 carry dedup keys and SHOULD hit the cache;
    // slot 1 has no key and re-runs. Net resolver invocations: 1.
    const runsBefore = runs;
    const second = await engine.mutate({
      frame: {
        'default/createTodo': [
          { params: { id: 'a' }, idempotencyKey: 'k-a' },
          { params: { id: 'b-again' } },
          { params: { id: 'c' }, idempotencyKey: 'k-c' }
        ]
      },
      ctx: makeCtx()
    });
    expect(second.errors).toBeUndefined();
    expect(runs - runsBefore).toBe(1);

    // Cached slots return the original per-frame value verbatim; slot 1
    // returns whatever the re-run produced.
    const secondData = second.data['default/createTodo'] as unknown[];
    expect(secondData[0]).toEqual({ id: 'a' });
    expect(secondData[2]).toEqual({ id: 'c' });
    expect(secondData[1]).toEqual({ id: 'b-again' });
  });

  it('mixed array lengths at different op-keys all commit independently', async () => {
    const { engine, registry } = bootstrap();
    registry.register('createTodo', { kind: 'mutation', resolver: createTodoResolver });
    registry.register('updateTodo', { kind: 'mutation', resolver: createTodoResolver });

    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': [{ params: { id: 'c1' } }],
        'default/updateTodo': [
          { params: { id: 'u1' } },
          { params: { id: 'u2' } },
          { params: { id: 'u3' } },
          { params: { id: 'u4' } }
        ]
      },
      ctx: makeCtx()
    });

    expect(envelope.errors).toBeUndefined();
    const createData = envelope.data['default/createTodo'] as unknown[];
    const updateData = envelope.data['default/updateTodo'] as unknown[];
    expect(createData).toHaveLength(1);
    expect(updateData).toHaveLength(4);
    expect(envelope.shapes['default/createTodo']).toEqual(['single']);
    expect(envelope.shapes['default/updateTodo']).toEqual(['single', 'single', 'single', 'single']);
  });

  it('empty array at an op-key surfaces `empty_frame_array` and runs no resolver', async () => {
    const { engine, registry } = bootstrap();
    let runs = 0;
    registry.register('createTodo', {
      kind: 'mutation',
      resolver: async () => {
        runs += 1;
        return { id: 'x' } as Row;
      }
    });

    const envelope = await engine.mutate({
      frame: { 'default/createTodo': [] },
      ctx: makeCtx()
    });

    expect(runs).toBe(0);
    expect(envelope.data['default/createTodo']).toBeUndefined();
    const err = envelope.errors?.[0];
    expect(err?.code).toBe('empty_frame_array');
    expect(err?.path).toEqual(['default/createTodo']);
    expect(err?.message).toContain('empty frame array');
  });

  it('query path rejects array values with `batched_not_supported`', async () => {
    const { engine, registry } = bootstrap();
    registry.register('Todo', { resolver: async () => [] });

    const envelope = await engine.query({
      frame: {
        'default/Todo': [
          { params: {}, fields: { id: true } },
          { params: {}, fields: { id: true } }
        ]
      },
      ctx: makeCtx()
    });
    const err = envelope.errors?.[0];
    expect(err?.code).toBe('batched_not_supported');
    expect(err?.path).toEqual(['default/Todo']);
  });

  it('bridged array op-key surfaces `bridge_array_not_supported` and never invokes the bridge', async () => {
    // Minimal bridge stub — we assert the engine never dispatches to it.
    let bridgeHits = 0;
    const stubClient: BridgeClient = {
      name: 'remote',
      baseUrl: 'http://never-called',
      federatedSchema: async () => ({}),
      query: async () => {
        bridgeHits += 1;
        return { schemaVersion: 'x', data: {}, shapes: {} };
      },
      mutate: async () => {
        bridgeHits += 1;
        return { schemaVersion: 'x', data: {}, shapes: {} };
      },
      readRow: async () => null,
      isReachable: () => true,
      dispose: () => {}
    };
    const bridges: BridgeRegistry = {
      has: (ns) => ns === 'remote',
      get: (ns) => (ns === 'remote' ? stubClient : undefined),
      isUnreachable: () => false,
      entries: () => [['remote', stubClient]]
    };
    const { engine } = bootstrap({ bridges });

    const envelope = await engine.mutate({
      frame: {
        'remote/createEvent': [{ params: { id: 'e1' } }, { params: { id: 'e2' } }]
      },
      ctx: makeCtx()
    });
    expect(bridgeHits).toBe(0);
    const err = envelope.errors?.[0];
    expect(err?.code).toBe('bridge_array_not_supported');
    expect(err?.path).toEqual(['remote/createEvent']);
  });
});
