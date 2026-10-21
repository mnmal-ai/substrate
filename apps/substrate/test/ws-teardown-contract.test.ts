/**
 * Wire-level conformance test for the slow-consumer teardown contract
 * (docs/ws-subscription-contract.md). Pins the exact frame
 * sequence a real WS client observes when a subscription breaches queueLimit:
 *   error { code: 'subscription_overloaded' }
 *   end   { reason: 'subscription_overloaded', final: true }
 * and nothing after the end frame. Engine-level semantics are pinned in
 * packages/substrate-sdk/test/async-cancellation.test.ts; this test exists so a
 * transport refactor can't silently break the on-wire contract.
 *
 * Also covers the WS route attributing teardown reasons to the engine metric:
 *   - conn.onClose  → cancel('socket_close') → engine_subscription_closed_socket_close
 *   - conn.onShutdown → cancel('shutdown')   → engine_subscription_closed_shutdown
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

/**
 * Wait until the socket stops delivering.
 *
 * Not a fixed sleep: under load a sleep can both admit stragglers from an
 * earlier mutate (failing a correct implementation) and expire before a
 * wrongly-sent frame arrives (hiding a violation).
 */
async function waitQuiet(count: () => number, stillMs = 50, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  let last = -1;
  while (last !== count()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitQuiet timeout');
    last = count();
    await new Promise((r) => setTimeout(r, stillMs));
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WS teardown contract: queueLimit breach over a real socket', () => {
  let server: FastifySubstrateServer;
  let composed: ComposeResult;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.close();
    await composed?.stop();
  });

  it('emits error{code} then end{reason, final} and nothing after', async () => {
    server = new FastifySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin],
      subscriptions: { queueLimit: 2 }
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });

    ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    const frames: WsResponseFrame[] = [];
    ws.on('message', (buf: Buffer) => {
      frames.push(JSON.parse(buf.toString('utf8')) as WsResponseFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(
      JSON.stringify({
        id: 'tc-1',
        op: 'subscribe',
        frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } }
      })
    );
    await waitFor(() => frames.some((f) => f.kind === 'snapshot'));

    // ONE batched mutate (6 frames under one op-key = one atomic tx). The
    // post-commit fanout enqueues all 6 push frames synchronously, so the
    // 3rd enqueue breaches queueLimit=2 before the drain loop can run.
    const batched = Array.from({ length: 6 }, (_, i) => ({
      params: { id: `b${i}`, title: `row-${i}`, done: false },
      fields: { id: true }
    }));
    const res = await fetch(`http://127.0.0.1:${port}/substrate/v1/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'default/createTodo': batched })
    });
    expect(res.ok).toBe(true);

    await waitFor(() => frames.some((f) => f.kind === 'end'));

    const errIdx = frames.findIndex(
      (f) => f.kind === 'error' && f.errors?.[0]?.code === 'subscription_overloaded'
    );
    const endIdx = frames.findIndex((f) => f.kind === 'end');
    expect(errIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(errIdx);
    expect(frames[endIdx]?.final).toBe(true);
    expect(frames[endIdx]?.reason).toBe('subscription_overloaded');

    // Nothing after the end frame. Settle first: `end` may be observed while
    // earlier frames are still arriving, so a count taken here without
    // quiescing races the tail of the first mutate.
    await waitQuiet(() => frames.length);
    expect(frames[frames.length - 1]?.kind).toBe('end');
    const lenAtEnd = frames.length;
    const res2 = await fetch(`http://127.0.0.1:${port}/substrate/v1/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'default/createTodo': { params: { id: 'after', title: 'after', done: false } }
      })
    });
    expect(res2.ok).toBe(true);
    // Quiesce again rather than sleeping a guess: if the implementation wrongly
    // pushes, this waits for that frame and the assertion catches it; if it
    // does not, this costs one tick.
    await waitQuiet(() => frames.length);
    expect(frames.length).toBe(lenAtEnd);

    // Entry is gone from the engine's bus.
    expect(composed.engine.activeSubscriptionCount()).toBe(0);
  });
});

describe('WS teardown reason attribution via /substrate/v1/metrics', () => {
  let server: FastifySubstrateServer;
  let composed: ComposeResult;
  let ws: WebSocket;

  afterEach(async () => {
    ws?.terminate?.();
    await composed?.stop();
  });

  it('socket_close: closing the WS emits engine_subscription_closed_socket_close', async () => {
    server = new FastifySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });

    ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    const frames: WsResponseFrame[] = [];
    ws.on('message', (buf: Buffer) => {
      frames.push(JSON.parse(buf.toString('utf8')) as WsResponseFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(
      JSON.stringify({
        id: 'sc-route-1',
        op: 'subscribe',
        frame: { 'default/Todo': { params: {}, fields: { id: true } } }
      })
    );
    await waitFor(() => frames.some((f) => f.kind === 'snapshot'));

    // Close the socket — this triggers conn.onClose on the server side.
    ws.close();
    // Wait for the engine bus to drain the subscription.
    await waitFor(() => composed.engine.activeSubscriptionCount() === 0);

    // Metrics endpoint must record the socket_close reason.
    const metricsRes = await fetch(`http://127.0.0.1:${port}/substrate/v1/metrics`);
    expect(metricsRes.ok).toBe(true);
    const body = (await metricsRes.json()) as { events: Record<string, number> };
    expect(body.events.engine_subscription_closed_socket_close).toBeGreaterThanOrEqual(1);
  });

  it('shutdown: stop() emits engine_subscription_closed_shutdown', async () => {
    server = new FastifySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });

    ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    const frames: WsResponseFrame[] = [];
    ws.on('message', (buf: Buffer) => {
      frames.push(JSON.parse(buf.toString('utf8')) as WsResponseFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(
      JSON.stringify({
        id: 'sd-route-1',
        op: 'subscribe',
        frame: { 'default/Todo': { params: {}, fields: { id: true } } }
      })
    );
    await waitFor(() => frames.some((f) => f.kind === 'snapshot'));

    // stop() calls notifyWsShutdown → conn.onShutdown → handle.cancel('shutdown')
    // → engine emits engine_subscription_closed_shutdown into stats.
    // The stats object outlives the HTTP server so we read it after stop().
    await composed.stop();

    // stats.snapshot() reads from in-memory counters that persist after stop().
    const snap = composed.stats.snapshot();
    expect(snap.events.engine_subscription_closed_shutdown ?? 0).toBeGreaterThanOrEqual(1);
    expect(composed.engine.activeSubscriptionCount()).toBe(0);
  });
});
