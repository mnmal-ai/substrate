import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import { AuthError, NetworkError } from '../src/errors.js';
import { readSse } from '../src/transport/sse.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';
const sse = (s: string) =>
  new HttpResponse(s, { headers: { 'content-type': 'text/event-stream' } });

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    }
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const e of readSse(body)) out.push(e);
  return out;
}

describe('readSse', () => {
  it('parses events split across chunk boundaries and skips comments', async () => {
    const out = await collect(
      streamOf([': keepalive\n\nevent: par', 'sed\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n'])
    );
    expect(out).toEqual([
      { event: 'parsed', data: { a: 1 } },
      { event: 'done', data: {} }
    ]);
  });

  it('handles CRLF line endings, including a CR/LF pair split across chunks', async () => {
    const out = await collect(
      streamOf(['event: parsed\r\ndata: {"a":1}\r\n\r', '\nevent: done\r\ndata: {}\r\n\r\n'])
    );
    expect(out).toEqual([
      { event: 'parsed', data: { a: 1 } },
      { event: 'done', data: {} }
    ]);
  });

  it('flushes a final event with no trailing blank line', async () => {
    const out = await collect(streamOf(['event: done\ndata: {"ok":true}\n']));
    expect(out).toEqual([{ event: 'done', data: { ok: true } }]);
  });
});

describe('readSse hardening', () => {
  it('cancels the source body when the consumer breaks early', async () => {
    const cancel = vi.fn();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc.encode('event: a\ndata: {}\n\n'));
      },
      cancel
    });
    for await (const _ of readSse(body)) break;
    expect(cancel).toHaveBeenCalled();
  });

  it('malformed data JSON throws a NetworkError naming the event and quoting the data', async () => {
    const err = await collect(streamOf(['event: rows\ndata: {not json\n\n'])).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toContain('rows');
    expect(err.message).toContain('{not json');
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('joins multi-line data with newline', async () => {
    const out = await collect(streamOf(['event: x\ndata: {"a":\ndata: 1}\n\n']));
    expect(out).toEqual([{ event: 'x', data: { a: 1 } }]);
  });

  it('accepts data: with no space and strips only one leading space', async () => {
    expect(await collect(streamOf(['event: x\ndata:{"a":1}\n\n']))).toEqual([
      { event: 'x', data: { a: 1 } }
    ]);
    // two spaces: one is stripped, the other is JSON whitespace; parse still succeeds
    expect(await collect(streamOf(['event: x\ndata:  {"a":1}\n\n']))).toEqual([
      { event: 'x', data: { a: 1 } }
    ]);
    // a string payload keeps its second space, proving only one was stripped
    expect(await collect(streamOf(['event: x\ndata:  "s"\n\n']))).toEqual([
      { event: 'x', data: 's' }
    ]);
  });

  it('skips an event with no data', async () => {
    const out = await collect(streamOf(['event: ping\n\nevent: done\ndata: {}\n\n']));
    expect(out).toEqual([{ event: 'done', data: {} }]);
  });
});

describe('client.nl', () => {
  it('a mid-stream abort ends iteration with an AbortError', async () => {
    const enc = new TextEncoder();
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('event: parsed\ndata: {}\n\n'));
          }
        });
        return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
      })
    );
    const ac = new AbortController();
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    const run = async () => {
      for await (const _ of c.nl.ask({ namespace: 'ns', question: 'q' }, { signal: ac.signal }))
        ac.abort();
    };
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the server JSON error body on the NetworkError', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () =>
        HttpResponse.json({ error: "unknown namespace 'x'", code: 'nl_x' }, { status: 404 })
      )
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    const err = await c.nl.askJson({ namespace: 'x', question: 'q' }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({
      status: 404,
      code: 'nl_x',
      serverMessage: "unknown namespace 'x'"
    });
    expect(err.message).toContain('404');
  });

  it('a non-JSON error body leaves code and serverMessage unset', async () => {
    mockHandlers(
      http.get(
        `${ENDPOINT}/substrate/v1/nl/pack/x`,
        () => new HttpResponse('Not Found', { status: 404 })
      )
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    const err = await c.nl.pack('x').catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
    expect(err.serverMessage).toBeUndefined();
  });

  it.each([401, 403])('maps %i to AuthError', async (status) => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () => new HttpResponse(null, { status }))
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    await expect(c.nl.askJson({ namespace: 'ns', question: 'q' })).rejects.toBeInstanceOf(
      AuthError
    );
  });

  it('two clients do not share the pack cache', async () => {
    const seen: (string | null)[] = [];
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/ns`, ({ request }) => {
        seen.push(request.headers.get('if-none-match'));
        return HttpResponse.json({ namespace: 'ns' }, { headers: { etag: '"e1"' } });
      })
    );
    await new SubstrateClient({ endpoint: ENDPOINT }).nl.pack('ns');
    await new SubstrateClient({ endpoint: ENDPOINT }).nl.pack('ns');
    expect(seen).toEqual([null, null]);
  });

  it('encodes the namespace in the pack path', async () => {
    let path = '';
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/:ns`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({});
      })
    );
    await new SubstrateClient({ endpoint: ENDPOINT }).nl.pack('a/b c');
    expect(path).toBe('/substrate/v1/nl/pack/a%2Fb%20c');
  });

  it('pack returns a copy so mutation cannot poison later 304 hits', async () => {
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/ns`, ({ request }) =>
        request.headers.get('if-none-match') === '"e1"'
          ? new HttpResponse(null, { status: 304 })
          : HttpResponse.json({ v: 1 }, { headers: { etag: '"e1"' } })
      )
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    const first = await c.nl.pack('ns');
    first.schemaVersion = 'mutated';
    expect(await c.nl.pack('ns')).toEqual({ v: 1 });
  });

  it('an unsolicited 304 on askJson is an error', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () => new HttpResponse(null, { status: 304 }))
    );
    await expect(
      new SubstrateClient({ endpoint: ENDPOINT }).nl.askJson({ namespace: 'ns', question: 'q' })
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('a caller Accept header replaces the default case-insensitively and GET sends no content-type', async () => {
    let accept: string | null = null;
    let ct: string | null = 'unset';
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/ns`, ({ request }) => {
        accept = request.headers.get('accept');
        ct = request.headers.get('content-type');
        return HttpResponse.json({});
      })
    );
    const { HttpTransport } = await import('../src/transport/http.js');
    const t = new HttpTransport({ endpoint: ENDPOINT });
    await t.raw('/substrate/v1/nl/pack/ns', {
      method: 'GET',
      headers: { Accept: 'application/x-test' }
    });
    expect(accept).toBe('application/x-test');
    expect(ct).toBeNull();
  });

  it('an empty SSE body is an error', async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const run = async () => {
      for await (const _ of new SubstrateClient({ endpoint: ENDPOINT, fetch: fetchImpl }).nl.ask({
        namespace: 'ns',
        question: 'q'
      })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toThrow(/empty SSE body/);
  });

  it('ask streams named events with accept: text/event-stream and bearer auth', async () => {
    let accept: string | null = null;
    let auth: string | null = null;
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, ({ request }) => {
        accept = request.headers.get('accept');
        auth = request.headers.get('authorization');
        return sse(
          'event: parsed\ndata: {"status":"resolved"}\n\nevent: rows\ndata: {"kind":"rows"}\n\nevent: done\ndata: {}\n\n'
        );
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT, token: 't' });
    const names = [];
    for await (const e of c.nl.ask({ namespace: 'ns', question: 'q' })) names.push(e.event);
    expect(names).toEqual(['parsed', 'rows', 'done']);
    expect(accept).toBe('text/event-stream');
    expect(auth).toBe('Bearer t');
  });

  it('an in-band error event throws with its code', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () =>
        sse('event: error\ndata: {"code":"nl_failed","message":"boom"}\n\n')
      )
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    await expect(async () => {
      for await (const _ of c.nl.ask({ namespace: 'ns', question: 'q' })) {
        /* drain */
      }
    }).rejects.toThrow(/nl_failed.*boom/);
  });

  it('askJson posts JSON and returns { outcome, trail }', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, async ({ request }) => {
        expect(await request.json()).toEqual({
          namespace: 'ns',
          question: 'q',
          project: 'substrate'
        });
        return HttpResponse.json({ outcome: { kind: 'refuse', reason: 'x' }, trail: [] });
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    expect(
      (await c.nl.askJson({ namespace: 'ns', question: 'q', project: 'substrate' })).outcome
    ).toEqual({ kind: 'refuse', reason: 'x' });
  });

  it('pack revalidates with the etag and reuses the cached body on 304', async () => {
    let calls = 0;
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/ns`, ({ request }) => {
        calls++;
        if (request.headers.get('if-none-match') === '"e1"')
          return new HttpResponse(null, { status: 304, headers: { etag: '"e1"' } });
        return HttpResponse.json({ namespace: 'ns' }, { headers: { etag: '"e1"' } });
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    expect(await c.nl.pack('ns')).toEqual({ namespace: 'ns' });
    expect(await c.nl.pack('ns')).toEqual({ namespace: 'ns' });
    expect(calls).toBe(2);
  });

  it('a 304 with no cached pack is an error, not an empty body', async () => {
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/ns`, () => new HttpResponse(null, { status: 304 }))
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    await expect(c.nl.pack('ns')).rejects.toThrow(/304/);
  });
});
