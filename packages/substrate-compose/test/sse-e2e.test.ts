/**
 * End-to-end regression for the REAL `/substrate/v1/stream` route over a REAL TCP
 * socket. Every other SSE test drives the route through `server.inject()` (no
 * socket) or exercises pure framing/session units, so none can catch a
 * regression that buffers the route (e.g. an interceptor that materializes the
 * body to compute `content-length`).
 *
 * The parity fixture's `default/streamTodos` delays only 1ms between rows —
 * too fast to tell streaming from buffering over a real socket. This file
 * registers its own slow producer via `registry.register` (not
 * `defineNamespace`, whose `TypeInput` has no raw-resolver escape hatch for a
 * hand-rolled async generator) with a deliberately measurable gap.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type {
  CoordinatorPlugin,
  FieldDef,
  NamespaceInstallContext,
  Row
} from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

/**
 * Gap between yields from the slow producer below. The assertion threshold is
 * half of this — generous enough to absorb CI scheduler jitter, tight enough
 * that a buffered implementation (which flushes everything in one turn, gaps
 * ~= 0ms) cannot pass. See `packages/substrate-server-fastify/test/streaming.test.ts`
 * for the same threshold reasoning at the transport-unit layer.
 */
const GAP_MS = 50;

const slowRowsFields: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string', indexed: true }
};

/**
 * A fast producer emits every chunk inside one event-loop turn, so the
 * socket flushes once and the test would prove nothing about buffering —
 * hence the explicit per-yield delay rather than reading pre-seeded rows.
 */
async function* slowRowsResolver(): AsyncGenerator<Row> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, GAP_MS);
      timer.unref?.();
    });
    yield { id: `r${i}` };
  }
}

function installSlowNamespace(ctx: NamespaceInstallContext): void {
  ctx.registry.register('slowRows', {
    kind: 'type',
    fields: slowRowsFields,
    resolver: slowRowsResolver
  });
}

const slowStreamPlugin: CoordinatorPlugin = {
  name: 'slow-stream-fixture',
  contractVersion: '*',
  namespaces: [
    {
      namespace: 'default',
      install: installSlowNamespace
    }
  ]
};

describe('SSE end-to-end: real route, real socket', () => {
  let server: FastifySubstrateServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new FastifySubstrateServer();
    await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [slowStreamPlugin]
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://${address}:${port}`;
  });

  afterEach(async () => {
    await server.stop({ grace: 0 });
  });

  it('delivers chunks incrementally from the real /substrate/v1/stream route', async () => {
    const res = await fetch(`${baseUrl}/substrate/v1/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'default/slowRows': { params: {}, fields: { id: true } } })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const arrivals: number[] = [];
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
      text += dec.decode(value, { stream: true });
    }

    expect(text).toContain('event: chunk');
    expect(text).toContain('event: end');
    // Never advertise a `Last-Event-ID` resume capability Substrate doesn't implement.
    expect(text).not.toMatch(/^id:/m);

    // A buffered implementation delivers everything in one flush (gaps ~0).
    // Half the producer gap absorbs scheduler jitter on noisy CI without
    // being loose enough for a buffered impl to pass.
    const gaps = arrivals.slice(1).map((t, i) => t - (arrivals[i] as number));
    expect(Math.max(...gaps)).toBeGreaterThan(GAP_MS / 2);
  });

  it('rejects a GET with no ticket before opening a stream', async () => {
    const frame = encodeURIComponent(JSON.stringify({ 'default/slowRows': { params: {} } }));
    const res = await fetch(`${baseUrl}/substrate/v1/stream?frame=${frame}`);
    expect(res.status).toBe(401);
    // Pre-stream failures are ordinary HTTP, NOT an SSE error frame.
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
