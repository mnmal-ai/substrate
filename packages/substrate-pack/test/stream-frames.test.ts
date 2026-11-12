import { unpack } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import {
  decodeStreamFrames,
  encodeStreamFrame,
  FRAMES_JSON_MIME,
  FRAMES_PACK_MIME,
  FrameStreamError,
  framesEncodingFromAccept,
  HEARTBEAT_FRAME
} from '../src/stream-frames.js';

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}

async function collect(
  body: AsyncIterable<Uint8Array>,
  maxFrameBytes?: number
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const p of decodeStreamFrames(
    body,
    maxFrameBytes === undefined ? {} : { maxFrameBytes }
  )) {
    out.push(p);
  }
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('stream frames', () => {
  it('round-trips json and pack frames', async () => {
    const a = { kind: 'snapshot', data: { 'ns/T': [{ id: '1' }] } };
    const b = { kind: 'end', final: true };
    const json = await collect(chunks(encodeStreamFrame(a, 'json'), encodeStreamFrame(b, 'json')));
    expect(json.map((p) => JSON.parse(new TextDecoder().decode(p)))).toEqual([a, b]);
    const pack = await collect(chunks(encodeStreamFrame(a, 'pack'), encodeStreamFrame(b, 'pack')));
    expect(pack.map((p) => unpack(p))).toEqual([a, b]);
  });

  it('writes a big-endian u32 length before the payload', () => {
    const f = encodeStreamFrame({ x: 1 }, 'json');
    const len = new DataView(f.buffer, f.byteOffset).getUint32(0, false);
    expect(len).toBe(f.length - 4);
    expect(new TextDecoder().decode(f.subarray(4))).toBe('{"x":1}');
  });

  it('reassembles a prefix split across chunks', async () => {
    const values = [{ n: 1 }, { n: 2, s: 'x'.repeat(300) }, { n: 3 }];
    const all = concat(...values.map((v) => encodeStreamFrame(v, 'json')));
    const oneByte = Array.from(all, (b) => Uint8Array.of(b));
    const out = await collect(chunks(...oneByte));
    expect(out.map((p) => JSON.parse(new TextDecoder().decode(p)))).toEqual(values);
  });

  it('skips heartbeat frames', async () => {
    const out = await collect(
      chunks(HEARTBEAT_FRAME, encodeStreamFrame({ n: 1 }, 'json'), HEARTBEAT_FRAME, HEARTBEAT_FRAME)
    );
    expect(out).toHaveLength(1);
    expect(HEARTBEAT_FRAME).toEqual(new Uint8Array(4));
  });

  it('refuses a length above maxFrameBytes with frame_too_large, before reading the payload', async () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, 0xffffffff, false);
    let pulled = 0;
    async function* stingy(): AsyncGenerator<Uint8Array> {
      pulled++;
      yield prefix;
      pulled++;
      yield new Uint8Array(1024);
    }
    const err = await collect(stingy(), 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrameStreamError);
    expect((err as FrameStreamError).code).toBe('frame_too_large');
    expect(pulled).toBe(1);
  });

  it('refuses EOF inside a frame with truncated_frame', async () => {
    const f = encodeStreamFrame({ n: 1 }, 'json');
    for (const cut of [2, f.length - 1]) {
      const err = await collect(chunks(f.subarray(0, cut))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FrameStreamError);
      expect((err as FrameStreamError).code).toBe('truncated_frame');
    }
  });

  it('reads a web ReadableStream body', async () => {
    const f = encodeStreamFrame({ n: 1 }, 'json');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(f.subarray(0, 3));
        c.enqueue(f.subarray(3));
        c.close();
      }
    });
    const out: Uint8Array[] = [];
    for await (const p of decodeStreamFrames(body)) out.push(p);
    expect(JSON.parse(new TextDecoder().decode(out[0]))).toEqual({ n: 1 });
  });

  it('framesEncodingFromAccept', () => {
    expect(framesEncodingFromAccept(`${FRAMES_PACK_MIME}; q=1`)).toBe('pack');
    expect(framesEncodingFromAccept(FRAMES_JSON_MIME)).toBe('json');
    expect(framesEncodingFromAccept(`application/json, ${FRAMES_JSON_MIME}`)).toBe('json');
    expect(framesEncodingFromAccept('text/event-stream')).toBeUndefined();
    expect(framesEncodingFromAccept(undefined)).toBeUndefined();
  });
});
