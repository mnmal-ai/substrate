import type { FieldInput } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { createSseTransport } from '../src/routes/sse.js';

const FIELDS = new Map<string, FieldInput>([['default/Todo', { id: true }]]);
const dec = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>, count: number): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (let i = 0; i < count; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  reader.releaseLock();
  return out;
}

describe('SseTransport', () => {
  it('opens with a retry directive', async () => {
    const { body } = createSseTransport({});
    expect(await readAll(body, 1)).toBe('retry: 5000\n\n');
  });

  it('emits frames as SSE events', async () => {
    const { transport, body } = createSseTransport({});
    void transport.emit({ id: 's1', kind: 'add', data: { 'default/Todo': { id: '1' } } }, FIELDS);
    const out = await readAll(body, 2);
    expect(out).toContain('event: add');
    expect(out).toContain('"row":{"id":"1"}');
  });

  it('closes the stream on close()', async () => {
    const { transport, body } = createSseTransport({});
    transport.close('complete');
    const reader = body.getReader();
    await reader.read(); // retry
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it('close() is idempotent', () => {
    const { transport } = createSseTransport({});
    transport.close('complete');
    expect(() => transport.close('client_disconnect')).not.toThrow();
  });

  it('emit after close does not throw', async () => {
    const { transport } = createSseTransport({});
    transport.close('complete');
    await expect(
      transport.emit({ id: 's1', kind: 'add', data: {} }, FIELDS)
    ).resolves.toBeUndefined();
  });

  it('sends a heartbeat on the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const { body } = createSseTransport({ heartbeatMs: 20_000 });
      const reader = body.getReader();
      await reader.read(); // retry
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(dec.decode((await pending).value)).toBe(': keepalive\n\n');
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the heartbeat after close (no dangling timer)', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = createSseTransport({ heartbeatMs: 20_000 });
      transport.close('complete');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invokes onCancel when the consumer cancels (client disconnect)', async () => {
    const onCancel = vi.fn();
    const { body } = createSseTransport({ onCancel });
    await body.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('SseTransport backpressure', () => {
  const dataFrame = (id: string): { id: string; kind: 'add'; data: Record<string, unknown> } => ({
    id,
    kind: 'add',
    data: {}
  });

  it('emit stays pending until the consumer creates demand', async () => {
    const { transport, body } = createSseTransport({});
    const reader = body.getReader();
    let resolved = false;
    const done = transport.emit(dataFrame('s1'), FIELDS).then(() => {
      resolved = true;
    });

    // First read only drains the retry directive queued at start(); the
    // just-enqueued data frame is still sitting in the queue, so there is no
    // demand yet and `emit` must still be parked.
    await reader.read();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Draining that data frame empties the queue, which is what triggers the
    // stream's `pull()` — the actual demand signal `emit` is waiting on.
    await reader.read();
    await done;
    expect(resolved).toBe(true);
  });

  it('two concurrent emits both resolve (no clobbered demand resolver)', async () => {
    const { transport, body } = createSseTransport({});
    const reader = body.getReader();
    await reader.read(); // drain the retry directive so the queue starts empty

    let resolved1 = false;
    let resolved2 = false;
    const p1 = transport.emit(dataFrame('s1'), FIELDS).then(() => {
      resolved1 = true;
    });
    const p2 = transport.emit(dataFrame('s2'), FIELDS).then(() => {
      resolved2 = true;
    });

    // Both frames are enqueued (queue holds 2, highWaterMark is 1), so both
    // `emit` calls park. A single-resolver implementation loses the first one
    // here — this is the regression case for that bug.
    await Promise.resolve();
    expect(resolved1).toBe(false);
    expect(resolved2).toBe(false);

    await reader.read(); // drains frame 1; queue still non-empty, no pull yet
    await Promise.resolve();
    await reader.read(); // drains frame 2; queue now empty -> pull() fires

    await Promise.all([p1, p2]);
    expect(resolved1).toBe(true);
    expect(resolved2).toBe(true);
  });

  it('a parked emit settles once close() runs, instead of hanging forever', async () => {
    const { transport } = createSseTransport({});
    // No reads at all: start() already left the queue full (the retry
    // directive alone saturates highWaterMark: 1), so this emit parks
    // immediately on demand that will never naturally arrive.
    const done = transport.emit(dataFrame('s1'), FIELDS);
    transport.close('complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('a parked emit settles once the consumer cancels, instead of hanging forever', async () => {
    const { transport, body } = createSseTransport({});
    const done = transport.emit(dataFrame('s1'), FIELDS);
    await body.cancel();
    await expect(done).resolves.toBeUndefined();
  });
});
