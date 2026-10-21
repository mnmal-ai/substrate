/**
 * Terminal-aware resubscribe — the WS teardown contract
 * (substrate repo docs/ws-subscription-contract.md).
 *
 * Class 1 (overload): `error { code: 'subscription_overloaded' }` +
 * `end { reason: 'subscription_overloaded' }` → the transport suppresses the
 * terminal and resubscribes with bounded backoff (default-on).
 * Class 2 (server_restart): the end event is delivered but the subscription
 * survives the socket bounce and resubscribes.
 * Classes 3/4 (cancel ack, other error codes): terminal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { SubstrateClient } from '../src/index.js';
import { WsTransport } from '../src/transport/ws.js';

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

function send(socket: WsSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

function sendOverloadTeardown(socket: WsSocket, id: unknown): void {
  send(socket, {
    id,
    kind: 'error',
    errors: [{ message: 'queue threshold exceeded', code: 'subscription_overloaded' }]
  });
  send(socket, { id, kind: 'end', final: true, reason: 'subscription_overloaded' });
}

describe('WsTransport — overload auto-resubscribe (contract class 1)', () => {
  it('suppresses the overload terminal and resubscribes; consumer sees two snapshots', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        if (subscribeCount === 1) {
          // First subscription: tear it down as overloaded right after the snapshot.
          sendOverloadTeardown(socket, msg.id);
        }
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      overloadResubscribe: { baseDelayMs: 10, maxDelayMs: 20, jitter: 0 }
    });

    const events: string[] = [];
    for await (const ev of transport.subscribe({ id: 'sub-ovl', frame: { 'default/Todo': {} } })) {
      events.push(ev.kind);
      if (events.filter((k) => k === 'snapshot').length === 2) break;
    }
    await transport.close();

    expect(subscribeCount).toBe(2);
    // The overload error/end never reached the consumer.
    expect(events).toEqual(['snapshot', 'snapshot']);
  });

  it('surfaces SubscribeError after the retry budget is exhausted', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        // Every subscription gets torn down as overloaded.
        sendOverloadTeardown(socket, msg.id);
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      overloadResubscribe: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10, jitter: 0 }
    });

    let thrown: unknown = null;
    const kinds: string[] = [];
    try {
      for await (const ev of transport.subscribe({
        id: 'sub-exh',
        frame: { 'default/Todo': {} }
      })) {
        kinds.push(ev.kind);
      }
    } catch (err) {
      thrown = err;
    }
    await transport.close();

    // Initial subscribe + 2 retries, then the 3rd overload exhausts the budget.
    expect(subscribeCount).toBe(3);
    expect(kinds).toEqual(['snapshot', 'snapshot', 'snapshot']);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe('subscription_overloaded');
  });

  it('enabled: false restores terminal-on-overload (no resubscribe)', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        sendOverloadTeardown(socket, msg.id);
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      overloadResubscribe: { enabled: false }
    });

    let thrown: unknown = null;
    try {
      for await (const _ev of transport.subscribe({
        id: 'sub-off',
        frame: { 'default/Todo': {} }
      })) {
        // drain
      }
    } catch (err) {
      thrown = err;
    }
    // Allow any (wrong) retry timer to fire before counting.
    await new Promise((r) => setTimeout(r, 50));
    await transport.close();

    expect((thrown as { code?: string })?.code).toBe('subscription_overloaded');
    expect(subscribeCount).toBe(1);
  });

  it('non-overload error codes never auto-resubscribe (contract class 4)', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, {
          id: msg.id,
          kind: 'error',
          errors: [{ message: 'filter invalid', code: 'filter_validation' }]
        });
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      overloadResubscribe: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 }
    });

    let thrown: unknown = null;
    try {
      for await (const _ev of transport.subscribe({
        id: 'sub-cls4',
        frame: { 'default/Todo': {} }
      })) {
        // drain
      }
    } catch (err) {
      thrown = err;
    }
    await new Promise((r) => setTimeout(r, 50));
    await transport.close();

    expect((thrown as { code?: string })?.code).toBe('filter_validation');
    expect(subscribeCount).toBe(1);
  });

  it('a sub healthy past healthyResetMs gets a fresh retry budget', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        // Overload every subscription; the client's healthy window (50ms)
        // elapses between recovery and the next teardown because we delay
        // the teardown beyond healthyResetMs.
        const current = subscribeCount;
        setTimeout(() => sendOverloadTeardown(socket, msg.id), current === 1 ? 0 : 80);
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      overloadResubscribe: {
        maxAttempts: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitter: 0,
        healthyResetMs: 50
      }
    });

    const kinds: string[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of transport.subscribe({ id: 'sub-hr', frame: { 'default/Todo': {} } })) {
        kinds.push(ev.kind);
        // Three successful snapshots prove at least two budget-resets worked
        // (maxAttempts is 1, so without the reset the 2nd overload would throw).
        if (kinds.length === 3) break;
      }
    } catch (err) {
      thrown = err;
    }
    await transport.close();

    expect(thrown).toBeNull();
    expect(kinds).toEqual(['snapshot', 'snapshot', 'snapshot']);
    expect(subscribeCount).toBeGreaterThanOrEqual(3);
  });
});

describe('WsTransport — retry-timer hygiene', () => {
  it('close() during overload backoff cancels the pending resubscribe', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        sendOverloadTeardown(socket, msg.id);
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      // Long enough that the close below always lands inside the backoff, even
      // when a loaded machine stretches the 10ms wait.
      overloadResubscribe: { baseDelayMs: 300, maxDelayMs: 300, jitter: 0 }
    });

    const it1 = transport
      .subscribe({ id: 'sub-tm', frame: { 'default/Todo': {} } })
      [Symbol.asyncIterator]();
    const first = await it1.next();
    expect((first.value as { kind: string }).kind).toBe('snapshot');
    // The overload terminal arrives and schedules a retry in 300ms. Close now.
    await new Promise((r) => setTimeout(r, 10));
    await transport.close();
    // Past the retry's due time: an uncancelled timer would have resubscribed.
    await new Promise((r) => setTimeout(r, 400));

    expect(subscribeCount).toBe(1); // no resubscribe after close
  });
});

describe('WsTransport — server_restart survival (contract class 2)', () => {
  it('delivers the end event, survives the bounce, and resubscribes', async () => {
    let connections = 0;
    wss.on('connection', (socket) => {
      connections += 1;
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        if (connections === 1) {
          // Graceful shutdown: structured end frame, then close 1012.
          send(socket, { id: msg.id, kind: 'end', final: true, reason: 'server_restart' });
          setTimeout(() => socket.close(1012, 'restart'), 10);
        }
      });
    });

    const transport = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      reconnect: { baseDelayMs: 10, maxDelayMs: 20, jitter: 0 }
    });

    const events: Array<{ kind: string; reason?: string }> = [];
    for await (const ev of transport.subscribe({ id: 'sub-sr', frame: { 'default/Todo': {} } })) {
      events.push({ kind: ev.kind, ...(ev.kind === 'end' ? { reason: ev.reason } : {}) });
      if (events.filter((e) => e.kind === 'snapshot').length === 2) break;
    }
    await transport.close();

    expect(connections).toBe(2);
    // The consumer still SEES the end event —
    // but iteration continues and the resubscribed snapshot follows.
    expect(events).toEqual([
      { kind: 'snapshot' },
      { kind: 'end', reason: 'server_restart' },
      { kind: 'snapshot' }
    ]);
  });

  it('a plain end (cancel ack — no reason) is still terminal', async () => {
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        send(socket, { id: msg.id, kind: 'end', final: true });
      });
    });

    const transport = new WsTransport({ endpoint: `ws://127.0.0.1:${port}` });

    const kinds: string[] = [];
    for await (const ev of transport.subscribe({ id: 'sub-pe', frame: { 'default/Todo': {} } })) {
      kinds.push(ev.kind);
    }
    await transport.close();

    // Loop exits on its own because the sub is marked done after the end.
    expect(kinds).toEqual(['snapshot', 'end']);
  });
});

describe('SubstrateClient — overloadResubscribe thread-through', () => {
  it('enabled: false surfaces SubscribeError on overload; subscribeCount stays 1', async () => {
    let subscribeCount = 0;
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op !== 'subscribe') return;
        subscribeCount += 1;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        sendOverloadTeardown(socket, msg.id);
      });
    });

    // SubstrateClient derives ws:// from the http:// endpoint automatically.
    const client = new SubstrateClient({
      endpoint: `http://127.0.0.1:${port}`,
      overloadResubscribe: { enabled: false }
    });

    let thrown: unknown = null;
    let subscribeCountAfterIterate = 0;
    try {
      for await (const _ev of client.subscribe({ 'default/Todo': {} })) {
        // drain
      }
    } catch (err) {
      thrown = err;
    }
    // Allow any (wrong) retry timer to fire before counting.
    await new Promise((r) => setTimeout(r, 50));
    subscribeCountAfterIterate = subscribeCount;
    await client.close();

    expect((thrown as { code?: string })?.code).toBe('subscription_overloaded');
    expect(subscribeCountAfterIterate).toBe(1);
  });
});
