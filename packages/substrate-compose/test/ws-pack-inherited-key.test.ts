/**
 * A pack-mode subscription selecting a field named after an Object prototype
 * key (`constructor`, `toString`) encodes it as an undeclared field instead of
 * throwing out of the un-awaited snapshot delivery.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { packFrame, unpackFrame } from '@mnmal-ai/substrate-pack';
import type {
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler
} from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { registerWsRoute } from '../src/routes/ws.js';

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
    let handler: WsHandler | undefined;
    const server = {
      route() {},
      websocket(_p: string, h: WsHandler) {
        handler = h;
      }
    } as unknown as SubstrateServer;
    registerWsRoute(server, engine, new Set(), () => {});
    let onMsg: ((b: Buffer) => void) | undefined;
    const sent: unknown[] = [];
    const conn = {
      id: 'c',
      send(d: unknown) {
        sent.push(d);
      },
      onMessage(cb: (b: Buffer) => void) {
        onMsg = cb;
      },
      onClose() {},
      close() {}
    } as unknown as WsConnection;
    await handler?.(
      { headers: { 'sec-websocket-protocol': 'substrate-pack' } } as unknown as SubstrateRequest,
      conn
    );
    onMsg?.(
      Buffer.from(
        packFrame({
          id: 'a',
          op: 'subscribe',
          frame: {
            'default/Memo': { params: {}, fields: { id: true, constructor: true, toString: true } }
          }
        })
      )
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(unhandled).toEqual([]);
    const kinds = sent.map((d) => (unpackFrame(d as Uint8Array) as { kind: string }).kind);
    expect(kinds).toContain('snapshot');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
