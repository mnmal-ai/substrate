import type { FieldInput } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { createDemandTransport } from '../src/routes/demand-transport.js';

const FIELDS = new Map<string, FieldInput>([['default/Todo', { id: true }]]);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Each frame as its JSON text, so a read shows which frame it was. */
function make(opts: { heartbeatMs?: number; stallMs?: number; onCancel?: () => void } = {}) {
  return createDemandTransport({
    encode: (frame) => enc.encode(JSON.stringify(frame)),
    heartbeat: enc.encode('HB'),
    ...opts
  });
}

const dataFrame = (id: string): { id: string; kind: 'add'; data: Record<string, unknown> } => ({
  id,
  kind: 'add',
  data: {}
});

describe('demand transport', () => {
  it('writes each emitted frame through encode', async () => {
    const { transport, body } = make();
    void transport.emit(dataFrame('s1'), FIELDS);
    const { value } = await body.getReader().read();
    expect(JSON.parse(dec.decode(value))).toMatchObject({ id: 's1', kind: 'add' });
  });

  it('closes the body on close(), and close() is idempotent', async () => {
    const { transport, body } = make();
    transport.close('complete');
    expect(() => transport.close('client_disconnect')).not.toThrow();
    expect((await body.getReader().read()).done).toBe(true);
  });

  it('emit after close does not throw', async () => {
    const { transport } = make();
    transport.close('complete');
    await expect(transport.emit(dataFrame('s1'), FIELDS)).resolves.toBeUndefined();
  });

  it('sends a heartbeat on the configured interval, and none after close', async () => {
    vi.useFakeTimers();
    try {
      const { transport, body } = make({ heartbeatMs: 20_000 });
      const reader = body.getReader();
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(dec.decode((await pending).value)).toBe('HB');
      reader.releaseLock();
      transport.close('complete');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invokes onCancel when the consumer cancels (client disconnect)', async () => {
    const onCancel = vi.fn();
    const { body } = make({ onCancel });
    await body.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('demand transport backpressure', () => {
  it('a data frame parks until the consumer reads it', async () => {
    const { transport, body } = make();
    const reader = body.getReader();
    let resolved = false;
    const done = transport.emit(dataFrame('s1'), FIELDS).then(() => {
      resolved = true;
    });
    // The frame fills the queue (high-water mark 1), so there is no demand yet.
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Draining it empties the queue, which fires `pull()`: the demand signal.
    await reader.read();
    await done;
    expect(resolved).toBe(true);
  });

  it('two concurrent emits both resolve (no clobbered demand resolver)', async () => {
    const { transport, body } = make();
    const reader = body.getReader();
    let resolved1 = false;
    let resolved2 = false;
    const p1 = transport.emit(dataFrame('s1'), FIELDS).then(() => {
      resolved1 = true;
    });
    const p2 = transport.emit(dataFrame('s2'), FIELDS).then(() => {
      resolved2 = true;
    });
    // Both park; a single-resolver implementation loses the first one.
    await Promise.resolve();
    expect(resolved1).toBe(false);
    expect(resolved2).toBe(false);
    await reader.read();
    await Promise.resolve();
    await reader.read();
    await Promise.all([p1, p2]);
    expect(resolved1 && resolved2).toBe(true);
  });

  it('never parks a terminal frame, which would hold the response open', async () => {
    const { transport } = make();
    void transport.emit(dataFrame('s1'), FIELDS); // fills the queue
    await expect(
      transport.emit({ id: 's1', kind: 'end', reason: 'complete', final: true }, FIELDS)
    ).resolves.toBeUndefined();
  });

  it('a parked emit settles once close() runs', async () => {
    const { transport } = make();
    const done = transport.emit(dataFrame('s1'), FIELDS);
    transport.close('complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('a parked emit settles once the consumer cancels', async () => {
    const { transport, body } = make();
    const done = transport.emit(dataFrame('s1'), FIELDS);
    await body.cancel();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('demand transport stall deadline', () => {
  it('a consumer that stops reading with data waiting is cut off at stallMs', async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      const { transport, body } = make({ stallMs: 1000, onCancel });
      const reader = body.getReader();
      const parked = transport.emit(dataFrame('s1'), FIELDS);
      await vi.advanceTimersByTimeAsync(999);
      expect(onCancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await parked;
      expect(onCancel).toHaveBeenCalledTimes(1);
      // The body errors rather than ending cleanly, so the client sees a broken stream.
      await expect(reader.read()).rejects.toThrow(/consumer_stalled/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a consumer that keeps reading is never cut off', async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      const { transport, body } = make({ stallMs: 1000, onCancel });
      const reader = body.getReader();
      for (let i = 0; i < 5; i++) {
        const parked = transport.emit(dataFrame(`s${i}`), FIELDS);
        await vi.advanceTimersByTimeAsync(800);
        await reader.read();
        await parked;
      }
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
