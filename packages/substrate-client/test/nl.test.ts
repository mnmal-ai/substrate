import { encodeStreamFrame, FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import { AuthError, NetworkError } from '../src/errors.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';
const frame = (event: string, data: unknown) => encodeStreamFrame({ event, data }, 'json');
const frames = (...parts: Uint8Array[]) =>
  new HttpResponse(Buffer.concat(parts), { headers: { 'content-type': FRAMES_JSON_MIME } });

describe('client.nl', () => {
  it('a mid-stream abort ends iteration with an AbortError', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(frame('parsed', {}));
          }
        });
        return new HttpResponse(body, { headers: { 'content-type': FRAMES_JSON_MIME } });
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

  it('a server that does not answer with frames is refused with frames_unsupported', async () => {
    const fetchImpl = (async () =>
      new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })) as typeof fetch;
    const run = async () => {
      for await (const _ of new SubstrateClient({ endpoint: ENDPOINT, fetch: fetchImpl }).nl.ask({
        namespace: 'ns',
        question: 'q'
      })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toMatchObject({ name: 'NetworkError', code: 'frames_unsupported' });
  });

  it('ask streams named events with accept: frames+json and bearer auth', async () => {
    let accept: string | null = null;
    let auth: string | null = null;
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, ({ request }) => {
        accept = request.headers.get('accept');
        auth = request.headers.get('authorization');
        return frames(
          frame('parsed', { status: 'resolved' }),
          frame('rows', { kind: 'rows' }),
          frame('done', {})
        );
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT, token: 't' });
    const names = [];
    for await (const e of c.nl.ask({ namespace: 'ns', question: 'q' })) names.push(e.event);
    expect(names).toEqual(['parsed', 'rows', 'done']);
    expect(accept).toBe(FRAMES_JSON_MIME);
    expect(auth).toBe('Bearer t');
  });

  it('an in-band error event throws with its code', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/nl`, () =>
        frames(frame('error', { code: 'nl_failed', message: 'boom' }))
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
