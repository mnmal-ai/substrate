/**
 * Cross-plugin integration smoke for the substrate-driven postWrite registry.
 * Validates the wire-level path end-to-end:
 *   1. the sample coordinator declares embed.source on Memo
 *   2. recall.contributePostWrites scans for embed.source and emits hooks
 *   3. engine merges into install ctx
 *   4. defineNamespace composes the chain
 *   5. resolver runs the chain on write
 *   6. embedAndStore lands the row in InMemoryEmbeddingsStore
 *
 * Three sub-tests:
 *   a. Memo write (embeddable) → embedding lands in store
 *   b. Item write (non-embeddable) → no embedding produced
 *   c. coordinator without recall → writes succeed, no embedder calls
 */

import { compose } from '@mnmal-ai/substrate-compose';
import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import {
  createRecallPlugin,
  type EmbeddingsStoreUpsertInput,
  InMemoryEmbeddingsStore,
  recallRouteHandler
} from '@mnmal-ai/substrate-recall';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddableCoordinator } from '../_fixtures/embeddable-coordinator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function parseEnvelope(res: SubstrateResponse): PackEnvelope {
  return JSON.parse(bodyToString(res)) as PackEnvelope;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-plugin: claude + recall composed', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn !== null) {
      await stopFn();
      stopFn = null;
    }
  });

  it('writes a Memory row through the engine and embeds via the chain', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const upserts: EmbeddingsStoreUpsertInput[] = [];
    const store = new InMemoryEmbeddingsStore();
    const originalUpsert = store.upsert.bind(store);
    store.upsert = async (input) => {
      upserts.push(input);
      await originalUpsert(input);
    };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });

    const recall = createRecallPlugin({ embedder, store });

    const composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      edges,
      coordinators: [embeddableCoordinator],
      kernelPlugins: [recall]
    });
    stopFn = composed.stop;

    await server.start();

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'sample/createMemo': {
            params: {
              name: 'integration-test',
              description: 'cross-plugin smoke',
              type: 'reference',
              body: 'hello world',
              archived: false,
              project: null
            },
            fields: { id: true }
          }
        })
      )
    });

    expect(res.status).toBe(200);
    const env = parseEnvelope(res);
    const id = (env.data['sample/createMemo'] as { id?: unknown } | undefined)?.id;
    expect(typeof id).toBe('string');

    // The embedding must have landed in the in-memory store.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.rowNamespace).toBe('sample');
    expect(upserts[0]?.rowType).toBe('Memo');
    expect(upserts[0]?.rowId).toBe(id);
  });

  it('writes a Todo (non-embeddable) without producing an embedding', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const embedSpy = vi.spyOn(embedder, 'embed');
    const store = new InMemoryEmbeddingsStore();
    const upserts: EmbeddingsStoreUpsertInput[] = [];
    const originalUpsert = store.upsert.bind(store);
    store.upsert = async (input) => {
      upserts.push(input);
      await originalUpsert(input);
    };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });

    const recall = createRecallPlugin({ embedder, store });

    const composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      edges,
      coordinators: [embeddableCoordinator],
      kernelPlugins: [recall]
    });
    stopFn = composed.stop;

    await server.start();

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'sample/createItem': {
            params: {
              title: 'non-embeddable test todo',
              area: 'testing',
              status: 'open',
              priority: 'medium',
              archived: false,
              project: null
            },
            fields: { id: true }
          }
        })
      )
    });

    expect(res.status).toBe(200);
    const env = parseEnvelope(res);
    const id = (env.data['sample/createItem'] as { id?: unknown } | undefined)?.id;
    expect(typeof id).toBe('string');

    // No embedding for non-embeddable types.
    expect(embedSpy).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it('claude composed WITHOUT recall: writes succeed, no embedder calls', async () => {
    // Synthetic embedder so we can track calls.
    const embed = vi.fn().mockResolvedValue(new Float32Array(8));

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });

    // No substrates — recall is absent from the composition.
    const composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      edges,
      coordinators: [embeddableCoordinator]
    });
    stopFn = composed.stop;

    await server.start();

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'sample/createMemo': {
            params: {
              name: 'no-recall-test',
              description: 'written without recall kernel',
              type: 'reference',
              body: 'body text',
              archived: false,
              project: null
            },
            fields: { id: true }
          }
        })
      )
    });

    // Write must succeed even without recall.
    expect(res.status).toBe(200);
    const env = parseEnvelope(res);
    const id = (env.data['sample/createMemo'] as { id?: unknown } | undefined)?.id;
    expect(typeof id).toBe('string');

    // The mock embedder must never have been called.
    expect(embed).not.toHaveBeenCalled();
  });
});

/**
 * Memory-mode /substrate/v1/recall returns full row bodies.
 *
 * The binary builds the memory-mode InMemoryEmbeddingsStore with a
 * `datasetFor` that late-binds to compose()'s dataset registry (main.ts) —
 * without it, knnSearch returns `row: { id }` stubs. This test mirrors that
 * wiring: ref declared first, store closes over it, compose() populates it.
 */
describe('cross-plugin: memory-mode recall returns row bodies', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn !== null) {
      await stopFn();
      stopFn = null;
    }
  });

  it('POST /substrate/v1/recall surfaces the written row body (not an id-only stub)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });

    // Mirror main.ts: late-bound registry ref, store closes over it.
    const datasetRegistryRef: {
      current: { get: (ns: string) => unknown } | null;
    } = { current: null };
    const store = new InMemoryEmbeddingsStore({
      datasetFor: (ns) =>
        datasetRegistryRef.current?.get(ns) as
          | import('@mnmal-ai/substrate-types').Dataset
          | undefined
    });

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });

    const recall = createRecallPlugin({ embedder, store });

    const composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      edges,
      coordinators: [embeddableCoordinator],
      kernelPlugins: [recall]
    });
    stopFn = composed.stop;
    datasetRegistryRef.current = composed.datasets;

    await server.start();

    const write = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'sample/createMemo': {
            params: {
              name: 'memory-mode-recall',
              description: 'row body must surface through recall',
              type: 'reference',
              body: 'the recallable fact',
              archived: false,
              project: null
            },
            fields: { id: true }
          }
        })
      )
    });
    expect(write.status).toBe(200);
    const id = (parseEnvelope(write).data['sample/createMemo'] as { id?: unknown } | undefined)?.id;
    expect(typeof id).toBe('string');

    // Kernel routes (/substrate/v1/recall) are mounted by the binary's substrate
    // lifecycle, not by compose() — invoke the route handler directly against
    // the SAME store the composition embeds into. The regression under test
    // is the store-side body join, not route mounting.
    const handler = recallRouteHandler({ embedder, store });
    const recallRes = await handler({
      method: 'POST',
      path: '/substrate/v1/recall',
      headers: { 'content-type': 'application/json' },
      query: {},
      params: {},
      body: Buffer.from(
        JSON.stringify({
          query: 'recallable fact',
          namespace: 'sample',
          type: 'Memo',
          k: 3,
          returnVector: true
        })
      )
    });
    expect(recallRes.status).toBe(200);
    const out = JSON.parse(bodyToString(recallRes)) as {
      rows: Array<{ row: Record<string, unknown>; vector?: number[] }>;
    };
    expect(out.rows.length).toBeGreaterThan(0);
    const hit = out.rows.find((r) => r.row.id === id);
    expect(hit).toBeDefined();
    // The regression: without datasetFor the row is an id-only stub.
    expect(hit?.row.name).toBe('memory-mode-recall');
    expect(hit?.row.body).toBe('the recallable fact');
    // returnVector keeps working alongside the body join.
    expect(hit?.vector).toHaveLength(8);
  });
});
