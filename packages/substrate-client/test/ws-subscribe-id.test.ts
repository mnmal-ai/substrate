/**
 * Regression: the WS subscription id must distinguish frames that differ only
 * by params — not just by qualified type name.
 *
 * With a shared id, re-subscribing with new params collides: the old sub's
 * server `end` races the new sub's same-id registration and silently
 * terminates it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { SubstrateClient } from '../src/client.js';

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const addr = wss.address();
  port = typeof addr === 'object' && addr ? (addr as { port: number }).port : 0;
});

afterEach(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
});

function parseMsg(raw: unknown): Record<string, unknown> {
  const str = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
  return JSON.parse(str) as Record<string, unknown>;
}

describe('SubstrateClient WS subscription id', () => {
  it('uses distinct ids for same-type subscriptions that differ only by params', async () => {
    const subscribeIds: string[] = [];
    wss.on('connection', (socket: WsSocket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op === 'subscribe') {
          subscribeIds.push(msg.id as string);
          socket.send(
            JSON.stringify({
              id: msg.id,
              kind: 'snapshot',
              data: { 'claude/Todo': [] },
              shapes: { 'claude/Todo': 'list' }
            })
          );
        }
      });
    });

    const client = new SubstrateClient({ endpoint: `http://127.0.0.1:${port}` });
    try {
      const frameA = {
        'claude/Todo': { params: { where: { project: { eq: 'alpha' } } }, fields: { id: true } }
      };
      const frameB = {
        'claude/Todo': { params: { where: { project: { eq: 'beta' } } }, fields: { id: true } }
      };

      const itA = client.subscribe(frameA)[Symbol.asyncIterator]();
      const evA = await itA.next();
      const itB = client.subscribe(frameB)[Symbol.asyncIterator]();
      const evB = await itB.next();

      expect(evA.done).toBe(false);
      expect(evB.done).toBe(false);
      expect((evA.value as { kind: string }).kind).toBe('snapshot');
      expect((evB.value as { kind: string }).kind).toBe('snapshot');

      await itA.return?.();
      await itB.return?.();

      expect(subscribeIds).toHaveLength(2);
      // Distinct frames → distinct ids, not both "claude/Todo".
      expect(subscribeIds[0]).not.toBe(subscribeIds[1]);
    } finally {
      await client.close();
    }
  });
});
