/**
 * Length-prefixed stream frames: the body of an HTTP/2 subscription or stream.
 *
 * Each frame is a big-endian u32 payload length, then the payload: UTF-8 JSON
 * or msgpack, exactly what `encodeWsFrame` writes for a WebSocket message, so
 * the positional pack decode plan applies unchanged. A zero-length frame is a
 * heartbeat and carries nothing.
 */

import { encodeWsFrame, type WireMode } from './wire.js';

export const FRAMES_JSON_MIME = 'application/vnd.substrate.frames+json';
export const FRAMES_PACK_MIME = 'application/vnd.substrate.frames+pack';
/** Largest payload a decoder accepts unless told otherwise. */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** A frame of length 0: keeps an idle stream alive, and decoders skip it. */
export const HEARTBEAT_FRAME: Uint8Array = new Uint8Array(4);

export class FrameStreamError extends Error {
  readonly code: 'frame_too_large' | 'truncated_frame';
  constructor(code: 'frame_too_large' | 'truncated_frame', message: string) {
    super(message);
    this.name = 'FrameStreamError';
    this.code = code;
  }
}

/** The frames encoding an `Accept` header asks for, or undefined when it asks for none. */
export function framesEncodingFromAccept(accept: string | undefined): WireMode | undefined {
  if (accept === undefined) return undefined;
  for (const clause of accept.split(',')) {
    const mime = (clause.split(';')[0] ?? '').trim();
    if (mime === FRAMES_PACK_MIME) return 'pack';
    if (mime === FRAMES_JSON_MIME) return 'json';
  }
  return undefined;
}

const utf8 = new TextEncoder();

/** One frame: u32 BE length, then `value` as JSON or msgpack. */
export function encodeStreamFrame(value: unknown, mode: WireMode): Uint8Array {
  const raw = encodeWsFrame(value, mode);
  const payload = typeof raw === 'string' ? utf8.encode(raw) : raw;
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/**
 * The payloads of a frame stream, in order, heartbeats skipped. A length above
 * `maxFrameBytes` throws `frame_too_large` before any of that payload is read
 * or allocated; a body that ends inside a frame throws `truncated_frame`.
 */
export async function* decodeStreamFrames(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  opts: { maxFrameBytes?: number } = {}
): AsyncGenerator<Uint8Array> {
  const max = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  // One growable buffer holding [start, end) unread bytes.
  let buf = new Uint8Array(4096);
  let start = 0;
  let end = 0;
  const append = (chunk: Uint8Array): void => {
    if (end + chunk.length > buf.length) {
      // Out of room at the tail: compact the unread bytes to the front, growing only if they still don't fit.
      const live = end - start;
      if (live + chunk.length > buf.length) {
        const grown = new Uint8Array(Math.max(buf.length * 2, live + chunk.length));
        grown.set(buf.subarray(start, end), 0);
        buf = grown;
      } else {
        buf.copyWithin(0, start, end);
      }
      start = 0;
      end = live;
    }
    buf.set(chunk, end);
    end += chunk.length;
  };
  const source: AsyncIterable<Uint8Array> =
    Symbol.asyncIterator in body ? (body as AsyncIterable<Uint8Array>) : readableToIterable(body);
  for await (const chunk of source) {
    append(chunk);
    while (end - start >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset + start, 4).getUint32(0, false);
      if (len > max) {
        throw new FrameStreamError(
          'frame_too_large',
          `frame of ${len} bytes exceeds the ${max}-byte limit`
        );
      }
      if (end - start < 4 + len) break;
      if (len > 0) yield buf.slice(start + 4, start + 4 + len);
      start += 4 + len;
    }
  }
  if (end - start > 0) {
    throw new FrameStreamError(
      'truncated_frame',
      `stream ended inside a frame (${end - start} bytes left over)`
    );
  }
}

async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
