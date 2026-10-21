import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import {
  type CloseReason,
  type SessionFrame,
  StreamSession,
  type StreamSessionInit,
  type StreamTransport
} from '../src/routes/stream-session.js';

/** Records every frame and close call; `emit` resolves immediately (no buffer). */
function fakeTransport(): StreamTransport & {
  frames: SessionFrame[];
  closes: CloseReason[];
} {
  const frames: SessionFrame[] = [];
  const closes: CloseReason[] = [];
  return {
    frames,
    closes,
    emit: async (frame) => {
      frames.push(frame);
    },
    close: (reason) => {
      closes.push(reason);
    }
  };
}

/** Minimal engine double — captures the onFrame callback so tests can drive it. */
function fakeEngine(): {
  engine: never;
  fire: (f: WsResponseFrame) => Promise<void>;
  cancelled: string[];
} {
  const cancelled: string[] = [];
  let onFrame: ((f: WsResponseFrame) => void | Promise<void>) | undefined;
  const engine = {
    subscribe: async (input: { onFrame: (f: WsResponseFrame) => void | Promise<void> }) => {
      onFrame = input.onFrame;
      return { cancel: (r?: string) => cancelled.push(r ?? 'cancel') };
    },
    stream: (input: { onFrame: (f: WsResponseFrame) => void | Promise<void> }) => {
      onFrame = input.onFrame;
      return { cancel: (r?: string) => cancelled.push(r ?? 'cancel') };
    }
  };
  return {
    engine: engine as never,
    fire: async (f) => {
      await onFrame?.(f);
    },
    cancelled
  };
}

// Explicit annotation (not `as const`) so `fields: { id: true }` matches
// `FieldInput`'s `true` literal rather than widening to `boolean` — plain
// object-literal inference widens boolean property values by default.
const INIT: StreamSessionInit = {
  id: 's1',
  mode: 'subscribe',
  frame: { 'default/Todo': { fields: { id: true } } },
  identity: null,
  headers: {}
};

describe('StreamSession', () => {
  it('forwards engine frames to the transport', async () => {
    const t = fakeTransport();
    const { engine, fire } = fakeEngine();
    await StreamSession.create(INIT, t).start(engine);

    await fire({ id: 's1', kind: 'snapshot', data: { 'default/Todo': [] } });

    expect(t.frames).toHaveLength(1);
    expect(t.frames[0]?.kind).toBe('snapshot');
  });

  it('passes the per-key selection map to the transport', async () => {
    const t = fakeTransport();
    const seen: Array<ReadonlyMap<string, unknown>> = [];
    t.emit = async (_f, fields) => {
      seen.push(fields);
    };
    const { engine, fire } = fakeEngine();
    await StreamSession.create(INIT, t).start(engine);

    await fire({ id: 's1', kind: 'add', data: {} });

    expect(seen[0]?.get('default/Todo')).toEqual({ id: true });
  });

  it('marks itself terminated on an end frame and closes the transport', async () => {
    const t = fakeTransport();
    const { engine, fire } = fakeEngine();
    const session = StreamSession.create(INIT, t);
    await session.start(engine);

    await fire({ id: 's1', kind: 'end', final: true });

    expect(session.isTerminated).toBe(true);
    expect(t.closes).toEqual(['complete']);
  });

  it('forwards an error frame WITHOUT swallowing it, then terminates', async () => {
    // Regression guard: a transport that silently dropped `subscription_overloaded`
    // would turn a loud failure into dropped data (same class as engine_id_miss).
    const t = fakeTransport();
    const { engine, fire } = fakeEngine();
    await StreamSession.create(INIT, t).start(engine);

    await fire({
      id: 's1',
      kind: 'error',
      errors: [{ message: 'too slow', code: 'subscription_overloaded' }]
    });

    expect(t.frames[0]?.kind).toBe('error');
    expect(t.frames[0]?.errors?.[0]?.code).toBe('subscription_overloaded');
  });

  it('cancel is idempotent and cancels the engine handle exactly once', async () => {
    const t = fakeTransport();
    const { engine, cancelled } = fakeEngine();
    const session = StreamSession.create(INIT, t);
    await session.start(engine);

    session.cancel('client_disconnect');
    session.cancel('client_disconnect');

    // The engine's own vocabulary, not the CloseReason — the token becomes the
    // `engine_subscription_closed_<reason>` metric suffix.
    expect(cancelled).toEqual(['socket_close']);
    expect(t.closes).toEqual(['client_disconnect']);
  });

  it('does not emit frames after cancellation', async () => {
    const t = fakeTransport();
    const { engine, fire } = fakeEngine();
    const session = StreamSession.create(INIT, t);
    await session.start(engine);
    session.cancel('client_disconnect');

    await fire({ id: 's1', kind: 'add', data: {} });

    expect(t.frames).toHaveLength(0);
  });

  it('awaits the transport emit — backpressure propagates to the engine', async () => {
    const t = fakeTransport();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.emit = async () => {
      await gate;
    };
    const { engine, fire } = fakeEngine();
    await StreamSession.create({ ...INIT, mode: 'stream' }, t).start(engine);

    const pending = fire({ id: 's1', kind: 'chunk', sequence: 0, data: {} });
    const settled = vi.fn();
    void pending.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled(); // still blocked on the transport

    release();
    await pending;
    expect(settled).toHaveBeenCalled();
  });
});
