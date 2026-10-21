/**
 * End-to-end streaming regression for FastifySubstrateServer.
 *
 * The unit-level translate test asserts that `applySubstrateResponse` hands
 * Fastify a Node `Readable` (not a buffered Buffer) when the handler returns
 * `body: ReadableStream`. That's necessary but not sufficient: a future change
 * could reintroduce buffering at a different layer (e.g. an interceptor that
 * waits on `reply.send` to settle, or a content-encoding middleware that
 * rebuilds the body). The only way to prove the wire actually streams is to
 * spin up a real TCP listener, send chunks across distinct event-loop turns,
 * and verify the client observes them as separate arrivals.
 *
 * PROVEN CAUSALLY, NOT BY TIMING. Chunks flushed separately can still be READ
 * together if the consumer is not scheduled in between, so a gap threshold
 * fails correct code under load.
 *
 * The producer GATES on the consumer: chunk N+1 is not enqueued until the
 * client has actually received chunk N. That makes the property causal rather
 * than temporal —
 *
 *   streaming impl  -> consumer receives chunk 1, releases the gate, and so on
 *                      to completion. Arrivals cannot coalesce, because the
 *                      later chunks do not exist yet.
 *   buffering impl  -> the server drains the whole body before sending
 *                      anything, so the consumer receives nothing, the gate is
 *                      never released, and the test times out.
 *
 * No threshold, no jitter budget, and the failure mode of a buffered
 * implementation is a hang rather than a subtly-wrong number.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

const encoder = new TextEncoder();

/**
 * A one-shot gate per chunk boundary. The producer awaits gate N before
 * enqueuing chunk N+1; the consumer opens it on receiving chunk N.
 */
function makeGates(count: number): {
  wait: (i: number) => Promise<void>;
  open: (i: number) => void;
} {
  const openers: Array<() => void> = [];
  const promises = Array.from(
    { length: count },
    (_, i) =>
      new Promise<void>((resolve) => {
        openers[i] = resolve;
      })
  );
  return {
    wait: (i) => promises[i] as Promise<void>,
    open: (i) => openers[i]?.()
  };
}

function makeGatedStream(
  chunks: ReadonlyArray<string>,
  gates: ReturnType<typeof makeGates>
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      // Chunk 0 goes immediately; every later chunk waits for proof that the
      // CLIENT received its predecessor. A buffered server never delivers
      // chunk 0, so this await never resolves and the test times out.
      if (i > 0) await gates.wait(i - 1);
      const chunk = chunks[i] as string;
      i++;
      controller.enqueue(encoder.encode(chunk));
    }
  });
}

const CHUNKS = ['data: a\n\n', 'data: b\n\n', 'data: c\n\n'] as const;

describe('FastifySubstrateServer streaming', () => {
  let server: FastifySubstrateServer;
  let gates: ReturnType<typeof makeGates>;
  let baseUrl: string;

  beforeEach(async () => {
    gates = makeGates(CHUNKS.length);
    server = new FastifySubstrateServer();
    server.route('GET', '/stream', () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: makeGatedStream(CHUNKS, gates)
    }));
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://${address}:${port}`;
  });

  afterEach(async () => {
    await server.stop({ grace: 0 });
  });

  it('streams ReadableStream response bodies chunk-by-chunk over the wire', async () => {
    const res = await fetch(`${baseUrl}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = res.body;
    if (body === null) throw new Error('expected a streaming body');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const arrivals: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arrivals.push(decoder.decode(value, { stream: true }));
      // Releasing the gate is what lets the producer emit the NEXT chunk. A
      // buffered server never gets here, because it delivers nothing until it
      // has drained a stream that is waiting on this call.
      gates.open(arrivals.length - 1);
    }

    // Joined text matches what the producer emitted.
    expect(arrivals.join('')).toBe(CHUNKS.join(''));

    // One arrival per chunk is a consequence of the gate: chunk N+1 does not
    // exist until chunk N has been received, so there is nothing to coalesce.
    expect(arrivals.length).toBe(CHUNKS.length);
  });
});
