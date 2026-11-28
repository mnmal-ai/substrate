/**
 * A store refusal thrown out of a mutate's transaction (a deadlock Postgres
 * broke, a pool with no free connection) reaches the caller in the envelope
 * under its own code, for a single frame and for an array.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, RequestContext, Resolver, Row } from '@mnmal-ai/substrate-types';
import { ResolverFrameError, WRITE_CONFLICT } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { NamespaceConfig } from '../src/index.js';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

const NS = 'default';
const KEY = `${NS}/createTodo`;

/** Rolls every transaction back and refuses it as a pg dataset refuses an aborted one. */
class ConflictingDataset extends MemoryDataset {
  override async withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    try {
      return await super.withTransaction(async (tx) => {
        await fn(tx);
        throw new Error('deadlock detected');
      });
    } catch {
      throw new ResolverFrameError(WRITE_CONFLICT, 'conflicted; retry it');
    }
  }
}

function bootstrap(): { engine: Engine; dataset: MemoryDataset } {
  const dataset = new ConflictingDataset({ namespace: NS });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, dataset);
  const registry = new Registry();
  registry.register('Todo', {
    kind: 'type',
    fields: { id: { kind: 'scalar', type: 'string' } },
    resolver: (async () => []) as unknown as Resolver
  });
  const resolver: Resolver = async (_ctx, args) => {
    const row = { id: (args.params as { id: string }).id } as Row;
    await args.dataset?.write('Todo', [row]);
    return row;
  };
  registry.register('createTodo', { kind: 'mutation', resolver });
  const namespaces = new Map<string, NamespaceConfig>([[NS, { registry }]]);
  const engine = new Engine({
    namespaces,
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    metric: () => {}
  });
  return { engine, dataset };
}

const ctx = { namespace: NS, identity: null } as unknown as RequestContext;
const frameOf = (id: string) => ({ params: { id }, fields: { id: true } });

describe('a refusal thrown out of a mutate transaction', () => {
  it('marks a single frame with the refusal code and returns no data', async () => {
    const { engine, dataset } = bootstrap();
    const envelope = await engine.mutate({ frame: { [KEY]: frameOf('a') }, ctx });

    expect(envelope.errors).toEqual([
      expect.objectContaining({
        code: WRITE_CONFLICT,
        path: [KEY],
        message: 'conflicted; retry it'
      })
    ]);
    expect(KEY in envelope.data).toBe(false);
    expect((await dataset.read('Todo', {})).rows).toEqual([]);
  });

  it('marks an array with the refusal code beside its rollback error', async () => {
    const { engine, dataset } = bootstrap();
    const envelope = await engine.mutate({
      frame: { [KEY]: [frameOf('a'), frameOf('b')] },
      ctx
    });

    expect(envelope.errors).toEqual([
      expect.objectContaining({
        code: WRITE_CONFLICT,
        path: [KEY],
        message: 'conflicted; retry it'
      }),
      expect.objectContaining({
        code: 'batched_frame_rolled_back',
        message: expect.stringContaining('conflicted; retry it')
      })
    ]);
    expect((await dataset.read('Todo', {})).rows).toEqual([]);
  });
});
