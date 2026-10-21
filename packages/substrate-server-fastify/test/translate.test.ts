import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { applySubstrateResponse, toSubstrateRequest } from '../src/translate.js';

function fakeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  const base = {
    method: 'get',
    url: '/foo?a=1&b=2',
    headers: {},
    query: {},
    params: {},
    body: undefined
  };
  return { ...base, ...overrides } as unknown as FastifyRequest;
}

describe('toSubstrateRequest', () => {
  it('uppercases the method', () => {
    const h = toSubstrateRequest(fakeRequest({ method: 'post' }));
    expect(h.method).toBe('POST');
  });

  it('strips the querystring from path', () => {
    const h = toSubstrateRequest(fakeRequest({ url: '/a/b?x=1' }));
    expect(h.path).toBe('/a/b');
  });

  it('throws on unsupported methods', () => {
    expect(() => toSubstrateRequest(fakeRequest({ method: 'TRACE' }))).toThrow(/Unsupported/);
  });

  it('flattens query strings', () => {
    const h = toSubstrateRequest(fakeRequest({ query: { a: '1', b: 2, c: ['x', 'y'] } }));
    expect(h.query).toEqual({ a: '1', b: '2', c: 'x' });
  });

  it('joins array-valued headers with comma-space', () => {
    const h = toSubstrateRequest(
      fakeRequest({
        headers: {
          'x-multi': ['one', 'two'],
          'x-single': 'ok'
        } as unknown as FastifyRequest['headers']
      })
    );
    expect(h.headers['x-multi']).toBe('one, two');
    expect(h.headers['x-single']).toBe('ok');
  });

  it('coerces numeric header values to strings', () => {
    const h = toSubstrateRequest(
      fakeRequest({
        headers: { 'x-num': 42 } as unknown as FastifyRequest['headers']
      })
    );
    expect(h.headers['x-num']).toBe('42');
  });

  it('drops undefined-valued headers', () => {
    const h = toSubstrateRequest(fakeRequest({ headers: { foo: undefined, bar: 'keep' } }));
    expect('foo' in h.headers).toBe(false);
    expect(h.headers.bar).toBe('keep');
  });

  describe('body coercion', () => {
    it('returns null when no body and no Content-Length', () => {
      const h = toSubstrateRequest(fakeRequest({ body: undefined }));
      expect(h.body).toBeNull();
    });

    it('returns Buffer.alloc(0) when Content-Length is present but body is empty', () => {
      const h = toSubstrateRequest(
        fakeRequest({ body: undefined, headers: { 'content-length': '0' } })
      );
      expect(Buffer.isBuffer(h.body)).toBe(true);
      expect(h.body?.length).toBe(0);
    });

    it('passes Buffer bodies through', () => {
      const b = Buffer.from('hello');
      const h = toSubstrateRequest(fakeRequest({ body: b }));
      expect(h.body).toBe(b);
    });

    it('wraps Uint8Array bodies', () => {
      const u = new Uint8Array([1, 2, 3]);
      const h = toSubstrateRequest(fakeRequest({ body: u }));
      expect(Buffer.isBuffer(h.body)).toBe(true);
      expect(Array.from(h.body as Buffer)).toEqual([1, 2, 3]);
    });

    it('encodes string bodies as utf-8', () => {
      const h = toSubstrateRequest(fakeRequest({ body: 'abc' }));
      expect(h.body).toEqual(Buffer.from('abc', 'utf8'));
    });

    it('re-serialises object bodies as JSON bytes', () => {
      const h = toSubstrateRequest(fakeRequest({ body: { k: 1 } }));
      expect(h.body).toEqual(Buffer.from('{"k":1}', 'utf8'));
    });
  });
});

function fakeReply() {
  let status = 0;
  const headers: Record<string, string | number | string[]> = {};
  let sentBody: unknown;
  const reply = {
    status(code: number) {
      status = code;
      return reply;
    },
    code(c: number) {
      status = c;
      return reply;
    },
    header(k: string, v: string | number | string[]) {
      headers[k] = v;
      return reply;
    },
    send(body?: unknown) {
      sentBody = body;
      return Promise.resolve(reply);
    },
    get _status() {
      return status;
    },
    get _headers() {
      return headers;
    },
    get _body() {
      return sentBody;
    }
  };
  return reply;
}

describe('applySubstrateResponse', () => {
  it('sets status and headers', async () => {
    const reply = fakeReply();
    await applySubstrateResponse(reply as unknown as FastifyReply, {
      status: 201,
      headers: { 'x-a': '1', 'x-b': '2' }
    });
    expect(reply._status).toBe(201);
    expect(reply._headers['x-a']).toBe('1');
    expect(reply._headers['x-b']).toBe('2');
  });

  it('passes Buffer bodies through', async () => {
    const reply = fakeReply();
    const b = Buffer.from('hi');
    await applySubstrateResponse(reply as unknown as FastifyReply, { status: 200, body: b });
    expect(reply._body).toBe(b);
  });

  it('converts Uint8Array bodies to Buffer', async () => {
    const reply = fakeReply();
    const u = new Uint8Array([1, 2]);
    await applySubstrateResponse(reply as unknown as FastifyReply, { status: 200, body: u });
    expect(Buffer.isBuffer(reply._body)).toBe(true);
  });

  it('passes string bodies through', async () => {
    const reply = fakeReply();
    await applySubstrateResponse(reply as unknown as FastifyReply, {
      status: 200,
      body: 'ok'
    });
    expect(reply._body).toBe('ok');
  });

  it('passes ReadableStream bodies through to Fastify as a Node Readable', async () => {
    // Regression: draining the Web ReadableStream to a Buffer defeats chunked
    // transfer encoding and breaks SSE. Fastify must get a Node Readable (via
    // Readable.fromWeb) so reply.send() pipes it without buffering.
    const reply = fakeReply();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([104, 105])); // 'hi'
        controller.close();
      }
    });
    await applySubstrateResponse(reply as unknown as FastifyReply, {
      status: 200,
      body: stream
    });
    expect(reply._body).toBeInstanceOf(Readable);
    expect(Buffer.isBuffer(reply._body)).toBe(false);
  });

  it('sends empty when body is undefined', async () => {
    const reply = fakeReply();
    await applySubstrateResponse(reply as unknown as FastifyReply, { status: 204 });
    expect(reply._body).toBeUndefined();
    expect(reply._status).toBe(204);
  });
});
