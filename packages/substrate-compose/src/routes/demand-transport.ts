/**
 * A response body paced to consumer demand. Spec §5.5.
 *
 * `emit` awaits the consumer's demand before resolving, and because the engine
 * awaits `onFrame` per chunk, that pause propagates back to the producer. Only
 * DATA-BEARING frames pace to demand — see the comment in `emit` for why
 * terminal frames must not.
 */

import type { FieldInput } from '@mnmal-ai/substrate-types';
import type { CloseReason, SessionFrame, StreamTransport } from './stream-session.js';

const DEFAULT_HEARTBEAT_MS = 20_000;
/** How long a data frame may wait for the consumer to read before the stream is cut off. */
export const DEFAULT_STALL_MS = 60_000;

export interface DemandTransportOptions {
  /** One frame as wire bytes; `fieldsByKey` is absent for route-owned frames. */
  encode: (
    frame: SessionFrame,
    fieldsByKey: ReadonlyMap<string, FieldInput> | undefined
  ) => Uint8Array;
  /** Written every `heartbeatMs` while the body is open. */
  heartbeat: Uint8Array;
  heartbeatMs?: number;
  /**
   * Most milliseconds a data frame waits for the consumer to read it. Past it
   * the body errors (`consumer_stalled`) and `onCancel` fires, so a client
   * that stopped reading frees its slot and its engine subscription.
   */
  stallMs?: number;
  /** Fired when the CONSUMER tears down — i.e. the client disconnected — or stalls. */
  onCancel?: () => void;
}

export interface DemandTransport {
  transport: StreamTransport;
  body: ReadableStream<Uint8Array>;
  /**
   * Write a frame the ROUTE owns rather than the session — today only the
   * graceful-shutdown `end`. Synchronous, and deliberately NOT part of
   * `StreamTransport`: that contract is the session's, and its async `emit`
   * exists to pace the producer to consumer demand. A shutdown frame is the
   * last write before the response closes, so parking it on demand could
   * strand it behind a consumer that has already stopped reading.
   */
  writeFrame: (frame: SessionFrame) => void;
}

/**
 * A response body paced to consumer demand, carrying one session's frames in
 * whatever wire encoding `encode` gives.
 */
export function createDemandTransport(opts: DemandTransportOptions): DemandTransport {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  /**
   * Resolvers of parked `emit` calls. Must be a Set, not a single slot: a
   * multi-key subscribe drains each key on its own task sharing one `onFrame`,
   * so two `emit`s can be in flight at once, and a single slot would strand
   * the first one's drain task.
   */
  const demand = new Set<() => void>();

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  /** Wake every parked `emit`, not just one — see the `demand` docblock. */
  const releaseDemand = (): void => {
    for (const resolve of demand) resolve();
    demand.clear();
  };

  /**
   * Shared by every teardown path (write failure, close, consumer cancel) so
   * none of them can leave the heartbeat ticking or an `emit` parked forever;
   * a parked `emit` strands the engine's producer loop.
   */
  const teardown = (): void => {
    closed = true;
    stopHeartbeat();
    releaseDemand();
  };

  const write = (bytes: Uint8Array): void => {
    if (closed || controller === null) return;
    try {
      controller.enqueue(bytes);
    } catch {
      // The consumer tore down between our `closed` check and the enqueue.
      // Every path that sets `closed` must run the FULL teardown: `close()`
      // short-circuits on the `closed` guard, so a bare flag flip here is the
      // last chance to stop the heartbeat and release parked `emit`s.
      teardown();
      controller = null;
    }
  };

  /** The consumer stopped reading with data waiting: error the body and cancel the session. */
  const stall = (): void => {
    if (closed) return;
    const c = controller;
    teardown();
    controller = null;
    try {
      c?.error(new Error('consumer_stalled'));
    } catch {
      // Already closed.
    }
    opts.onCancel?.();
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      heartbeat = setInterval(() => write(opts.heartbeat), heartbeatMs);
      // Node keeps the process alive for interval timers; a keepalive must not.
      heartbeat.unref?.();
    },
    pull() {
      // New demand exists — every parked `emit` gets a chance to re-check and
      // proceed, not just the most recently parked one.
      releaseDemand();
    },
    cancel() {
      // Client disconnected. Release any parked `emit` (it would otherwise
      // park forever — nothing will ever call `pull` again) and notify the
      // route so it can cancel the underlying session.
      teardown();
      controller = null;
      opts.onCancel?.();
    }
  });

  const transport: StreamTransport = {
    emit: async (frame: SessionFrame, fieldsByKey: ReadonlyMap<string, FieldInput>) => {
      if (closed) return;
      write(opts.encode(frame, fieldsByKey));
      // `end`/`error` are terminal: the session awaits this call and then
      // closes the transport. A terminal frame parked on demand would hold the
      // response open forever once the consumer stops reading, so only
      // data-bearing frames pace to consumer demand.
      if (frame.kind === 'end' || frame.kind === 'error') return;
      // Yield until the consumer asks for more. `desiredSize <= 0` means the
      // queue is full; waiting on the next `pull` (or a teardown, which also
      // releases `demand`) is the backpressure signal.
      if (controller !== null && (controller.desiredSize ?? 1) <= 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(stall, stallMs);
          timer.unref?.();
          demand.add(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close: (_reason: CloseReason) => {
      // `_reason` is intentionally unused: the terminal reason already ships
      // in the `end` frame's own payload.
      if (closed) return;
      teardown();
      try {
        controller?.close();
      } catch {
        // Already closed by the consumer — nothing to do.
      }
      controller = null;
    }
  };

  return {
    transport,
    body,
    writeFrame: (frame: SessionFrame) => write(opts.encode(frame, undefined))
  };
}
