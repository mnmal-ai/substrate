import type { SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import type { NlEngineAccess } from '../access.js';
import { PackService } from '../pack/service.js';
import { askHandler, packHandler } from '../routes.js';
import { OPERATORS, s } from './_fixture.js';

const SCHEMA = {
  schemaVersion: 'v1',
  mutations: {},
  types: { Todo: { fields: { title: s(), status: s({ enum: ['open', 'closed'] }), project: s() } } }
};
const engine: NlEngineAccess = {
  federatedSchema: () => ({ ns: SCHEMA }),
  operators: () => OPERATORS,
  query: async (frame) => ({
    data: { [Object.keys(frame)[0] as string]: [{ id: '1', title: 't', status: 'open' }] }
  })
};
const deps = () => ({ engine, packs: new PackService({ engine }) });
const post = (
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): SubstrateRequest => ({
  method: 'POST',
  path: '/substrate/v1/nl',
  headers: { 'content-type': 'application/json', ...headers },
  query: {},
  params: {},
  body: Buffer.from(JSON.stringify(body)),
  ...(signal !== undefined ? { signal } : {})
});
const text = async (b: unknown) => new Response(b as ReadableStream).text();

describe('POST /substrate/v1/nl', () => {
  it('JSON by default: { outcome, trail }', async () => {
    const res = await askHandler(deps())(post({ namespace: 'ns', question: 'open todos' }));
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body));
    expect(body.outcome).toMatchObject({ kind: 'rows', source: 'parser' });
    expect(body.trail.map((e: { event: string }) => e.event)).toEqual([
      'parsed',
      'outcome',
      'done'
    ]);
  });

  it('SSE when accept is text/event-stream: parsed, rows, done in order', async () => {
    const res = await askHandler(deps())(
      post({ namespace: 'ns', question: 'open todos' }, { accept: 'text/event-stream' })
    );
    expect(res.headers?.['content-type']).toBe('text/event-stream');
    const names = [...(await text(res.body)).matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(['parsed', 'rows', 'done']);
  });

  it('SSE with a scripted judge: parsed, judging, judged, rows, done in exactly that order', async () => {
    const replies: unknown[] = [
      { action: 'type', type: 'Todo' },
      { action: 'pick', candidate: 0 }
    ];
    const judge = { decide: async () => replies.shift() };
    const res = await askHandler({ ...deps(), judge })(
      post({ namespace: 'ns', question: 'zorblax quux' }, { accept: 'text/event-stream' })
    );
    const names = [...(await text(res.body)).matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(['parsed', 'judging', 'judged', 'rows', 'done']);
  });

  it('validates namespace and question; unknown namespace is 404', async () => {
    expect((await askHandler(deps())(post({ question: 'x' }))).status).toBe(400);
    expect((await askHandler(deps())(post({ namespace: 'ns', question: '' }))).status).toBe(400);
    expect((await askHandler(deps())(post({ namespace: 'nope', question: 'x' }))).status).toBe(404);
  });

  it('a question over the length cap is 400 naming the cap', async () => {
    const res = await askHandler(deps())(post({ namespace: 'ns', question: 'x'.repeat(8193) }));
    expect(res.status).toBe(400);
    expect(String(res.body)).toContain('8192');
  });

  it('prototype-named questions answer 200, never 502', async () => {
    for (const question of ['constructor', '__proto__', 'todos where constructor is open']) {
      const res = await askHandler(deps())(post({ namespace: 'ns', question }));
      expect(res.status, question).toBe(200);
    }
  });

  it('a type that is not an own key of the pack is 400', async () => {
    for (const type of ['constructor', '__proto__', 'Nope']) {
      const res = await askHandler(deps())(post({ namespace: 'ns', question: 'open', type }));
      expect(res.status, type).toBe(400);
      expect(JSON.parse(String(res.body)).error).toBe(`unknown type '${type}'`);
    }
    const ok = await askHandler(deps())(post({ namespace: 'ns', question: 'open', type: 'Todo' }));
    expect(ok.status).toBe(200);
  });

  it('a { prompt, question } body routes as the new shape', async () => {
    const res = await askHandler(deps())(
      post({ namespace: 'ns', question: 'open todos', prompt: 'x' })
    );
    expect(res.status).toBe(200);
  });

  it('JSON: a thrown engine error is 502 nl_engine_error', async () => {
    const bad: NlEngineAccess = {
      ...engine,
      query: async () => {
        throw new Error('engine not ready');
      }
    };
    const res = await askHandler({ engine: bad, packs: new PackService({ engine }) })(
      post({ namespace: 'ns', question: 'open todos' })
    );
    expect(res.status).toBe(502);
    expect(JSON.parse(String(res.body))).toMatchObject({ code: 'nl_engine_error' });
  });

  it('SSE: a thrown engine error is an in-band error event', async () => {
    const bad: NlEngineAccess = {
      ...engine,
      query: async () => {
        throw new Error('engine not ready');
      }
    };
    const res = await askHandler({ engine: bad, packs: new PackService({ engine }) })(
      post({ namespace: 'ns', question: 'open todos' }, { accept: 'text/event-stream' })
    );
    const out = await text(res.body);
    expect(out).toMatch(/event: error\ndata: .*nl_engine_error/);
  });

  it('never echoes engine error text to the client, and logs it once', async () => {
    const bad: NlEngineAccess = {
      ...engine,
      query: async () => {
        throw new Error('SELECT secret FROM x');
      }
    };
    const logged: unknown[] = [];
    const d = {
      engine: bad,
      packs: new PackService({ engine }),
      log: (e: unknown) => logged.push(e)
    };
    const json = await askHandler(d)(post({ namespace: 'ns', question: 'open todos' }));
    expect(json.status).toBe(502);
    expect(String(json.body)).not.toContain('SELECT');
    expect(JSON.parse(String(json.body))).toEqual({
      error: 'NL query failed',
      code: 'nl_engine_error'
    });
    const sse = await askHandler(d)(
      post({ namespace: 'ns', question: 'open todos' }, { accept: 'text/event-stream' })
    );
    const out = await text(sse.body);
    expect(out).not.toContain('SELECT');
    expect(out).toMatch(/event: error\ndata: .*nl_engine_error/);
    expect(logged.map((e) => (e as Error).message)).toEqual([
      'SELECT secret FROM x',
      'SELECT secret FROM x'
    ]);
  });

  it('a pack rejection is 502, or 499 when the client is gone', async () => {
    const badEngine: NlEngineAccess = {
      ...engine,
      federatedSchema: () => {
        throw new Error('not ready');
      }
    };
    const d = { engine, packs: new PackService({ engine: badEngine }) };
    const r = await askHandler(d)(post({ namespace: 'ns', question: 'x' }));
    expect(r.status).toBe(502);
    expect(JSON.parse(String(r.body))).toMatchObject({ code: 'nl_engine_error' });
    const ac = new AbortController();
    ac.abort();
    const g = await askHandler(d)(post({ namespace: 'ns', question: 'x' }, {}, ac.signal));
    expect(g.status).toBe(499);
    expect(g.body).toBeUndefined();
  });

  it('a client disconnect mid-stream cancels the generator', async () => {
    const ac = new AbortController();
    const res = await askHandler(deps())(
      post({ namespace: 'ns', question: 'open todos' }, { accept: 'text/event-stream' }, ac.signal)
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    ac.abort();
    await reader.cancel();
    // no throw, no hang: reaching here is the assertion
    expect(true).toBe(true);
  });
});

describe('GET /substrate/v1/nl/pack/:ns', () => {
  const get = (ns: string, headers: Record<string, string> = {}): SubstrateRequest => ({
    method: 'GET',
    path: `/substrate/v1/nl/pack/${ns}`,
    headers,
    query: {},
    params: { ns },
    body: null
  });
  it('prototype-named namespaces are 404, not 502', async () => {
    for (const ns of ['__proto__', 'constructor', 'toString']) {
      expect((await packHandler(deps())(get(ns))).status, ns).toBe(404);
    }
  });
  it('200 with etag, then 304 on if-none-match', async () => {
    const d = deps();
    const a = await packHandler(d)(get('ns'));
    expect(a.status).toBe(200);
    const etag = a.headers?.etag as string;
    expect(JSON.parse(String(a.body)).namespace).toBe('ns');
    const b = await packHandler(d)(get('ns', { 'if-none-match': etag }));
    expect(b.status).toBe(304);
    expect(b.body).toBeUndefined();
  });
  it('carries etag, cache-control and vary on 200 and etag + vary on 304', async () => {
    const d = deps();
    const a = await packHandler(d)(get('ns'));
    expect(a.headers).toMatchObject({
      'cache-control': 'private, no-cache',
      vary: 'authorization'
    });
    const b = await packHandler(d)(get('ns', { 'if-none-match': a.headers?.etag as string }));
    expect(b.headers).toMatchObject({ etag: a.headers?.etag, vary: 'authorization' });
  });
  it('a pack rejection is 502 nl_engine_error', async () => {
    const bad: NlEngineAccess = {
      ...engine,
      federatedSchema: () => {
        throw new Error('not ready');
      }
    };
    const r = await packHandler({ engine, packs: new PackService({ engine: bad }) })(get('ns'));
    expect(r.status).toBe(502);
    expect(JSON.parse(String(r.body))).toMatchObject({ code: 'nl_engine_error' });
  });
  it('404 names the unknown namespace', async () => {
    const r = await packHandler(deps())(get('nope'));
    expect(r.status).toBe(404);
    expect(String(r.body)).toMatch(/nope/);
  });
});
