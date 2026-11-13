/**
 * Length-prefixed frame streams: the body of POST `/substrate/v1/subscribe` and
 * `/substrate/v1/stream` when the client accepts `application/vnd.substrate.frames+json`
 * or `+pack`. Each frame's payload is a `WsResponseFrame` encoded by `serializeFrame`,
 * so a client decodes it with the frame codec and the pack decode plan.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import {
  encodeStreamFrame,
  FRAMES_JSON_MIME,
  FRAMES_PACK_MIME,
  FrameStreamError,
  HEARTBEAT_FRAME,
  type WireMode
} from '@mnmal-ai/substrate-pack';
import type { FieldInput } from '@mnmal-ai/substrate-types';
import { createDemandTransport, type DemandTransport } from './demand-transport.js';
import { encodeDataForPack } from './pack-frame.js';
import { projectWsFrame } from './project-json.js';
import type { SessionFrame } from './stream-session.js';

export function framesHeaders(mode: WireMode): Record<string, string> {
  return {
    'content-type': mode === 'pack' ? FRAMES_PACK_MIME : FRAMES_JSON_MIME,
    'cache-control': 'no-store',
    // Defeats proxy buffering, which would otherwise defeat streaming entirely.
    'x-accel-buffering': 'no'
  };
}

export interface FramesTransportOptions {
  mode: WireMode;
  engine: Engine;
  heartbeatMs?: number;
  /** Fired when the client disconnects, or stops reading for the stall deadline. */
  onCancel?: () => void;
  /** Fired, before `onCancel`, when the consumer stopped reading for the stall deadline. */
  onStall?: () => void;
  /**
   * Fired after a frame too large to send was replaced by an `error` and an
   * `end`, so the route ends the session: a subscriber that missed a frame
   * holds state the server can no longer vouch for.
   */
  onTooLarge: () => void;
}

export function createFramesTransport(opts: FramesTransportOptions): DemandTransport {
  const { mode, engine } = opts;
  let tooLarge = false;

  const payload = (
    frame: SessionFrame,
    fieldsByKey: ReadonlyMap<string, FieldInput> | undefined
  ) =>
    mode === 'pack'
      ? encodeDataForPack(frame, fieldsByKey, engine)
      : projectWsFrame(frame, fieldsByKey);

  const encode = (
    frame: SessionFrame,
    fieldsByKey: ReadonlyMap<string, FieldInput> | undefined
  ): Uint8Array => {
    try {
      return encodeStreamFrame(payload(frame, fieldsByKey), mode);
    } catch (err) {
      if (!(err instanceof FrameStreamError)) throw err;
      tooLarge = true;
      const error = encodeStreamFrame(
        { id: frame.id, kind: 'error', errors: [{ code: err.code, message: err.message }] },
        mode
      );
      const end = encodeStreamFrame(
        { id: frame.id, kind: 'end', reason: err.code, final: true },
        mode
      );
      const out = new Uint8Array(error.length + end.length);
      out.set(error);
      out.set(end, error.length);
      return out;
    }
  };

  const inner = createDemandTransport({
    encode,
    heartbeat: HEARTBEAT_FRAME,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.onCancel !== undefined ? { onCancel: opts.onCancel } : {}),
    ...(opts.onStall !== undefined ? { onStall: opts.onStall } : {})
  });

  return {
    ...inner,
    transport: {
      emit: async (frame, fieldsByKey) => {
        if (tooLarge) return;
        const sent = inner.transport.emit(frame, fieldsByKey);
        // Before awaiting: a data frame parks on demand, and the reader may never ask again.
        if (tooLarge) opts.onTooLarge();
        await sent;
      },
      close: inner.transport.close
    }
  };
}
