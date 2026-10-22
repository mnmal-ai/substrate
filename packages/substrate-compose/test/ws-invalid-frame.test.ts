/**
 * A `frame` whose entries are not objects must be refused at parse time.
 * `StreamSession` reads `entry.fields` on every entry while the socket's
 * message listener is still running, so a `null` entry used to throw there,
 * uncaught, and exit the process.
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

async function openSocket(): Promise<{
  send: (msg: unknown) => void;
  sends: WsResponseFrame[];
  engineCalls: string[];
}> {
  const engineCalls: string[] = [];
  const engine = {
    subscribe: async () => void engineCalls.push('subscribe'),
    stream: () => void engineCalls.push('stream')
  } as never as Engine;

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
  return { send: (msg) => onMsg?.(Buffer.from(JSON.stringify(msg))), sends, engineCalls };
}

describe('WS route: frame entries that are not objects', () => {
  for (const [label, entry] of [
    ['null', null],
    ['an array', [1]],
    ['a string', 'x']
  ] as const) {
    for (const op of ['subscribe', 'stream'] as const) {
      it(`answers invalid_frame for a ${op} whose entry is ${label}`, async () => {
        const { send, sends, engineCalls } = await openSocket();

        expect(() => send({ id: 'r1', op, frame: { 'x/Y': entry } })).not.toThrow();

        expect(sends).toHaveLength(1);
        expect(sends[0]?.kind).toBe('error');
        expect(sends[0]?.errors?.[0]?.code).toBe('invalid_frame');
        expect(engineCalls).toEqual([]);
      });
    }
  }
});
