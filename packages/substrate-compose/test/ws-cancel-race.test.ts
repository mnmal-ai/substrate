/**
 * A `cancel` frame can arrive in the SAME synchronous batch as the `stream`
 * frame it cancels — memory transports invoke message listeners inline
 * (`MemoryWsConnection.send`), and a real socket can deliver two frames from one
 * data event. The route must therefore have the session registered BEFORE it
 * dispatches to the engine.
 *
 * When it doesn't, the cancel takes the unknown-id branch: it acks with a plain
 * `end { final: true }` and the stream runs on uncancelled, so the client sees
 * chunks — and a second terminal — AFTER a frame marked final. That's a
 * wire-protocol violation, not just a lost cancellation.
 *
 * The bar: exactly one frame, `end { _meta.cancelled }`, zero chunks.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  Resolver,
  Row,
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler,
  WsResponseFrame
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

describe('WS route: cancel racing dispatch in one synchronous batch', () => {
  it('cancels a stream whose `cancel` arrives before the engine dispatch settles', async () => {
    const engine = buildEngine(5);

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    registerWsRoute(server, engine, new Set(), () => {});

    const sends: WsResponseFrame[] = [];
    let onMsg: ((b: Buffer) => void) | undefined;
    const conn: WsConnection = {
      id: 'c1',
      send: (f): void => {
        sends.push(JSON.parse(typeof f === 'string' ? f : Buffer.from(f).toString('utf8')));
      },
      onMessage: (cb): void => {
        onMsg = cb;
      },
      onClose: (): void => {},
      close: (): void => {}
    };
    await wsHandler?.({ headers: {} } as unknown as SubstrateRequest, conn);

    // Both frames delivered inline, no await between them.
    onMsg?.(
      Buffer.from(
        JSON.stringify({
          id: 'r1',
          op: 'stream',
          frame: { 'default/streamItems': { params: {}, fields: { id: true } } }
        })
      )
    );
    onMsg?.(Buffer.from(JSON.stringify({ id: 'r1', op: 'cancel' })));

    // Give the engine's producer loop every chance to leak a chunk.
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));

    expect(sends.filter((f) => f.kind === 'chunk')).toHaveLength(0);
    expect(sends).toHaveLength(1);
    const terminal = sends[0];
    expect(terminal?.kind).toBe('end');
    expect(terminal?.final).toBe(true);
    expect((terminal as { _meta?: { cancelled?: boolean } })?._meta?.cancelled).toBe(true);
  });

  it('cancels a subscription whose `cancel` arrives in the same batch', async () => {
    const engine = buildEngine(0);

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    registerWsRoute(server, engine, new Set(), () => {});

    const sends: WsResponseFrame[] = [];
    let onMsg: ((b: Buffer) => void) | undefined;
    const conn: WsConnection = {
      id: 'c2',
      send: (f): void => {
        sends.push(JSON.parse(typeof f === 'string' ? f : Buffer.from(f).toString('utf8')));
      },
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
          id: 's1',
          op: 'subscribe',
          frame: { 'default/streamItems': { params: {}, fields: { id: true } } }
        })
      )
    );
    onMsg?.(Buffer.from(JSON.stringify({ id: 's1', op: 'cancel' })));

    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 2));

    // Subscriptions don't self-emit on cancel, so the route owns the terminal —
    // exactly one, and it must be the LAST frame. (This target isn't
    // subscribable; what's pinned is the ordering invariant.)
    const ends = sends.filter((f) => f.kind === 'end');
    expect(ends).toHaveLength(1);
    expect(sends[sends.length - 1]?.kind).toBe('end');
  });
});
