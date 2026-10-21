/**
 * Wire-level conformance test for SSE graceful shutdown.
 *
 * A subscribe never self-ends, so `stop()` must end live SSE sessions itself
 * (as the WS route does with `end { reason: 'server_restart' }`) or
 * `fastify.close()` waits forever. The binary's `abortInFlight: true` masks a
 * hang, so these tests call bare `ComposeResult.stop()` as a library embedder
 * would.
 *
 * Two properties, one per test: the call returns, and the client sees the same
 * structured terminal WS clients get (pinned against
 * apps/substrate/test/ws-teardown-contract.test.ts).
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Race a promise against a deadline. A hung `stop()` is the defect under test,
 * so it must surface as a failed assertion rather than as the suite's own
 * timeout — the latter reports "test timed out" and names nothing.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Read `event:`/`data:` blocks off a live body until the response ends. A read
 * error resolves rather than rejects: the cleanup path aborts the request to
 * unstick a failing assertion, and that abort is not itself a test failure.
 */
async function drain(body: ReadableStream<Uint8Array>, sink: SseEvent[]): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const chunk = await reader.read().catch(() => null);
    if (chunk === null || chunk.done) return;
    buffered += decoder.decode(chunk.value, { stream: true });
    let at = buffered.indexOf('\n\n');
    while (at !== -1) {
      const block = buffered.slice(0, at);
      buffered = buffered.slice(at + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event !== undefined && data !== undefined) {
        sink.push({ event, data: JSON.parse(data) as Record<string, unknown> });
      }
      at = buffered.indexOf('\n\n');
    }
  }
}

describe('SSE graceful shutdown', () => {
  let composed: ComposeResult | undefined;
  let abort: AbortController | undefined;

  afterEach(async () => {
    abort?.abort();
    // `abortInFlight` is the escape hatch the binary uses. The cleanup must not
    // hang when the assertion under test fails, so it takes that path even
    // though the test itself deliberately does not.
    await composed?.stop({ grace: 1000, abortInFlight: true });
    composed = undefined;
  });

  /** Boot a server and open a live SSE subscribe against it. */
  async function bootWithLiveSubscribe(): Promise<{
    events: SseEvent[];
    drained: Promise<void>;
    running: ComposeResult;
  }> {
    const server = new FastifySubstrateServer();
    const running = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [fixturePlugin]
    });
    composed = running;
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });

    abort = new AbortController();
    // POST, not GET: the harness composes without auth so the gate is the
    // identity function, and a POST needs no stream ticket.
    const res = await fetch(`http://127.0.0.1:${port}/substrate/v1/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'default/Todo': { params: {}, fields: { id: true } } }),
      signal: abort.signal
    });
    expect(res.status).toBe(200);
    if (res.body === null) throw new Error('SSE route returned no stream body');

    const events: SseEvent[] = [];
    const drained = drain(res.body, events);
    await waitFor(() => events.some((e) => e.event === 'snapshot'));
    return { events, drained, running };
  }

  it('bare stop() returns while an SSE subscribe is open', async () => {
    const { drained, running } = await bootWithLiveSubscribe();

    const outcome = await withTimeout(running.stop(), 3000);

    expect(outcome).not.toBe(TIMED_OUT);
    expect(await withTimeout(drained, 3000)).not.toBe(TIMED_OUT);
  }, 15_000);

  it('emits end{reason: server_restart} and attributes the shutdown metric', async () => {
    const { events, drained, running } = await bootWithLiveSubscribe();

    await withTimeout(running.stop(), 3000);
    await withTimeout(drained, 3000);

    const end = events.find((e) => e.event === 'end');
    expect(end).toBeDefined();
    // Same terminal-cause token the WS route emits — one vocabulary, both
    // transports (docs/ws-subscription-contract.md).
    expect(end?.data).toEqual({ reason: 'server_restart' });
    // Nothing after the terminal.
    expect(events.at(-1)?.event).toBe('end');

    expect(running.stats.snapshot().events.engine_subscription_closed_shutdown ?? 0).toBe(1);
    expect(running.engine.activeSubscriptionCount()).toBe(0);
    // Two 3s races plus boot exceed vitest's 5s default; the races are what
    // must report the failure, not the runner clock.
  }, 15_000);
});
