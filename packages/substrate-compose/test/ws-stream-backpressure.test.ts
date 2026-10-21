/**
 * The stream route must pace chunk production to the transport's send buffer.
 * The engine awaits `onFrame` per chunk (§5.5), so the route awaiting
 * `conn.drain()` after each chunk turns that into real back-pressure: a fast
 * producer parks on the drain instead of piling frames into the socket buffer
 * unbounded.
 *
 * Driven through `registerWsRoute` with a fake connection whose `drain()` is a
 * gate released one tick at a time — each release must unblock exactly one
 * more chunk.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  Resolver,
  Row,
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { registerWsRoute } from '../src/routes/ws.js';

function buildEngine(rowCount: number): Engine {
  const rows: Row[] = Array.from({ length: rowCount }, (_, i) => ({ id: `i${i}` }));
  const streamItems: Resolver = async function* () {
    for (const r of rows) yield r;
  };
  const registry = new Registry();
  registry.register('streamItems', { resolver: streamItems });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  return new Engine({
    namespaces: new Map([['default', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-06-28T00:00:00Z') })
  });
}

async function settle(pred: () => boolean, ms = 300): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
}

describe('stream route awaits transport drain between chunks', () => {
  it('paces chunk production behind conn.drain() (back-pressure)', async () => {
    const engine = buildEngine(3);

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    registerWsRoute(server, engine, new Set(), () => {});
    expect(wsHandler).toBeDefined();

    const sends: string[] = [];
    const drains: Array<() => void> = [];
    let onMsg: ((b: Buffer) => void) | undefined;
    const conn: WsConnection = {
      id: 'c1',
      send: (f): void => {
        sends.push(typeof f === 'string' ? f : Buffer.from(f).toString('utf8'));
      },
      drain: (): Promise<void> => new Promise<void>((resolve) => drains.push(resolve)),
      onMessage: (cb): void => {
        onMsg = cb;
      },
      onClose: (): void => {},
      close: (): void => {}
    };

    await wsHandler?.({ headers: {} } as unknown as SubstrateRequest, conn);
    expect(onMsg).toBeDefined();

    onMsg?.(
      Buffer.from(
        JSON.stringify({
          id: 'r1',
          op: 'stream',
          frame: { 'default/streamItems': { params: {}, fields: { id: true } } }
        })
      )
    );

    const kinds = (): string[] => sends.map((s) => JSON.parse(s).kind as string);

    // Only the first chunk ships; the producer is parked on the first drain.
    await settle(() => drains.length >= 1);
    expect(kinds()).toEqual(['chunk']);
    expect(drains.length).toBe(1);

    // Each drain release unblocks exactly one more chunk.
    drains[0]?.();
    await settle(() => sends.length >= 2);
    expect(kinds()).toEqual(['chunk', 'chunk']);

    drains[1]?.();
    await settle(() => sends.length >= 3);
    expect(kinds()).toEqual(['chunk', 'chunk', 'chunk']);

    // Final chunk's drain releases; the terminal end frame needs no drain wait.
    drains[2]?.();
    await settle(() => kinds().includes('end'));
    expect(kinds()).toEqual(['chunk', 'chunk', 'chunk', 'end']);
  });
});
