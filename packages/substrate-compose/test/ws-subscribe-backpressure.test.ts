/**
 * The WS route must pace SUBSCRIPTION deltas (snapshot/add/update/remove), not
 * only §5.5 stream chunks — matching SSE, which paces everything except the
 * terminals. The parity gate asserts frame CONTENT, not timing, so it cannot
 * catch a divergence here. The sibling `ws-stream-backpressure.test.ts` covers
 * chunks.
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

function buildEngine(rowCount = 2): Engine {
  const rows: Row[] = Array.from({ length: rowCount }, (_, i) => ({ id: `t${i}` }));
  const listThings: Resolver = async () => rows;
  const registry = new Registry();
  registry.register('Thing', { resolver: listThings });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  return new Engine({
    namespaces: new Map([['default', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-08-10T00:00:00Z') })
  });
}

async function settle(pred: () => boolean, ms = 300): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
}

describe('WS paces subscription deltas, matching SSE', () => {
  it('parks a subscription frame on conn.drain() instead of shipping unpaced', async () => {
    const engine = buildEngine();

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    registerWsRoute(server, engine, new Set(), () => {});

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
    onMsg?.(
      Buffer.from(
        JSON.stringify({
          id: 'r1',
          op: 'subscribe',
          frame: { 'default/Thing': { params: {}, fields: { id: true } } }
        })
      )
    );

    // The snapshot is data-bearing, so it must park on a drain.
    await settle(() => drains.length >= 1);
    expect(drains.length).toBe(1);
    expect(sends.length).toBe(1);
    expect(JSON.parse(sends[0] as string).kind).toBe('snapshot');
  });

  it('never parks a terminal frame — that would defer close() indefinitely', async () => {
    // The exemption is load-bearing, not an optimisation: StreamSession awaits
    // this call and then closes the transport, so a consumer that stopped
    // reading right after a terminal would hold a server-owned response open
    // with nobody left to drain it. SSE carries the identical carve-out.
    const engine = buildEngine();

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    registerWsRoute(server, engine, new Set(), () => {});

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
    onMsg?.(
      Buffer.from(
        JSON.stringify({
          id: 'r1',
          op: 'subscribe',
          frame: { 'nope/Missing': { params: {}, fields: { id: true } } }
        })
      )
    );

    // An unknown namespace produces a terminal error. It must arrive without
    // waiting on a drain that nobody is going to release.
    await settle(() => sends.length >= 1);
    const kinds = sends.map((s) => JSON.parse(s).kind as string);
    expect(kinds).toContain('error');
    expect(drains.length).toBe(0);
  });
});
