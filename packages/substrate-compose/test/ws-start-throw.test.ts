/**
 * DEFENCE IN DEPTH, not a fix for a reproducible bug.
 *
 * A throwing plugin policy does NOT reject out of `session.start`:
 * `evaluatePolicy` (`policy-evaluator.ts`) catches it and the route surfaces a
 * clean `policy_denied` frame. But `start` returns a promise, and ANY rejection
 * path — a substrate error, a dataset failure, a plugin swapping the engine —
 * would otherwise be an unhandled rejection AND leave the session registered
 * until socket close, with the client waiting forever for a frame that never
 * comes.
 *
 * So these tests drive a rejection directly through an engine double, as the
 * SSE suite does. They pin the route's BEHAVIOUR on rejection; they do not
 * assert that any particular engine path rejects today.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type {
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { registerWsRoute } from '../src/routes/ws.js';

/**
 * Engine double whose dispatch rejects. The message mimics the shape a real
 * internal failure would have, so the leak assertions below are meaningful.
 */
function buildEngine(): Engine {
  return {
    subscribe: async () => {
      throw new TypeError("Cannot read properties of null (reading 'capabilities')");
    },
    stream: () => {
      throw new TypeError("Cannot read properties of null (reading 'capabilities')");
    }
  } as never;
}

describe('WS route: engine dispatch rejects instead of emitting', () => {
  it('sends a terminal error + end rather than leaving the client hanging', async () => {
    const engine = buildEngine();

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    registerWsRoute(server, engine, new Set(), (name, payload) => {
      metrics.push({ name, payload });
    });

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

    onMsg?.(
      Buffer.from(
        JSON.stringify({
          id: 'r1',
          op: 'subscribe',
          frame: { 'default/Todo': { params: {}, fields: { id: true } } }
        })
      )
    );

    // Let the rejection settle through the .catch.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));

    const err = sends.find((f) => f.kind === 'error');
    expect(err).toBeDefined();
    expect(err?.errors?.[0]?.code).toBe('stream_start_failed');

    const end = sends.find((f) => f.kind === 'end');
    expect(end?.final).toBe(true);

    // The client must not learn what threw: no raw TypeError message on the wire.
    expect(JSON.stringify(sends)).not.toContain('TypeError');
    expect(JSON.stringify(sends)).not.toContain('capabilities');

    // ...but the OPERATOR must. An opaque wire answer plus no server-side
    // trace is a failure nobody can see from either side.
    const trace = metrics.find((m) => m.name === 'ws_stream_start_failed');
    expect(trace).toBeDefined();
    // The trace carries EXACTLY what the wire withholds. `capabilities` is
    // asserted absent from `sends` five lines up and present here, which pins
    // both halves of the contract in one pair of assertions: opaque to the
    // client, diagnosable by the operator.
    expect(JSON.stringify(trace?.payload)).toContain('capabilities');
    expect(trace?.payload).toMatchObject({ mode: 'subscribe', keys: ['default/Todo'] });
  });

  it('unregisters the session so a later cancel is not answered as if it were live', async () => {
    const engine = buildEngine();

    let wsHandler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler): void => {
        wsHandler = h;
      }
    } as unknown as SubstrateServer;
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    registerWsRoute(server, engine, new Set(), (name, payload) => {
      metrics.push({ name, payload });
    });

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

    onMsg?.(
      Buffer.from(
        JSON.stringify({
          id: 'r1',
          op: 'subscribe',
          frame: { 'default/Todo': { params: {}, fields: { id: true } } }
        })
      )
    );
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));

    const before = sends.length;
    onMsg?.(Buffer.from(JSON.stringify({ id: 'r1', op: 'cancel' })));
    await new Promise((r) => setTimeout(r, 5));

    // Unknown-id cancel acks with a bare `end` — proving the failed session was
    // removed rather than left registered against a dead handle.
    const after = sends.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.kind).toBe('end');
    expect(after[0]?.final).toBe(true);
  });
});
