/**
 * A pack-mode subscription selecting a field named after an Object prototype
 * key (`constructor`, `toString`) encodes it as an undeclared field instead of
 * throwing out of the snapshot delivery.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { decodeStreamFrames, decodeWsEnvelope, FRAMES_PACK_MIME } from '@mnmal-ai/substrate-pack';
import type { HttpHandler, SubstrateServer } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { registerStreamRoutes } from '../src/routes/stream-routes.js';

it('pack subscribe selecting inherited keys delivers a snapshot', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const registry = new Registry();
    registry.register('Memo', { resolver: async () => [{ id: 'm1' }] });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', new MemoryDataset({ namespace: 'default' }));
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
    const routes = new Map<string, HttpHandler>();
    const server = {
      route(method: string, path: string, h: HttpHandler) {
        routes.set(`${method} ${path}`, h);
      }
    } as unknown as SubstrateServer;
    registerStreamRoutes(
      server,
      engine,
      new Set(),
      (h) => h,
      () => {}
    );
    const res = await routes.get('POST /substrate/v1/subscribe')?.({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      headers: { accept: FRAMES_PACK_MIME },
      query: {},
      params: {},
      body: Buffer.from(
        JSON.stringify({
          'default/Memo': { params: {}, fields: { id: true, constructor: true, toString: true } }
        })
      )
    });
    expect(res?.status).toBe(200);
    const frames = decodeStreamFrames(res?.body as ReadableStream<Uint8Array>)[
      Symbol.asyncIterator
    ]();
    const first = await frames.next();
    await frames.return?.(undefined);

    expect(unhandled).toEqual([]);
    expect(decodeWsEnvelope<{ kind: string }>(first.value as Uint8Array, 'pack').kind).toBe(
      'snapshot'
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
