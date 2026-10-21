/**
 * HttpBridgeClient — §5.8 HTTP surface. All tests use an injected fetch stub;
 * no real HTTP is opened. Health-probe intervals are tiny (10ms) and every
 * test disposes at teardown so no timer leaks.
 */

import type { PackEnvelope, Schema } from '@mnmal-ai/substrate-types';
import { BridgeUnreachableError } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpBridgeClient } from '../src/index.js';

interface StubCall {
  url: string;
  method: string;
  body: string | undefined;
}

interface StubFetch {
  fetch: typeof fetch;
  calls: StubCall[];
  next(
    responder: (
      url: string,
      init: RequestInit | undefined
    ) => { status: number; body: unknown } | Error
  ): void;
}

function mkFetch(
  defaultResponder: (
    url: string,
    init: RequestInit | undefined
  ) => { status: number; body: unknown } | Error = () => ({
    status: 200,
    body: {}
  })
): StubFetch {
  const calls: StubCall[] = [];
  const queue: Array<
    (url: string, init: RequestInit | undefined) => { status: number; body: unknown } | Error
  > = [];

  const shim: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const method = (init?.method ?? 'GET').toString();
    calls.push({ url, method, body });
    const responder = queue.length > 0 ? queue.shift() : defaultResponder;
    if (responder === undefined) throw new Error('no responder');
    const result = responder(url, init);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' }
    });
  };

  return {
    fetch: shim,
    calls,
    next(responder): void {
      queue.push(responder);
    }
  };
}

describe('HttpBridgeClient', () => {
  let stub: StubFetch;
  let client: HttpBridgeClient;

  beforeEach(() => {
    stub = mkFetch();
  });

  afterEach(() => {
    client?.dispose();
  });

  it('federatedSchema hits /substrate/v1/federated-schema and parses the response', async () => {
    const schema: Record<string, Schema> = {
      cal: { schemaVersion: 'abcdef123456', types: {}, mutations: {} }
    };
    stub.next(() => ({ status: 200, body: schema }));
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    const out = await client.federatedSchema();
    expect(out).toEqual(schema);
    expect(stub.calls[0]?.url).toBe('http://cal.internal/substrate/v1/federated-schema');
    expect(stub.calls[0]?.method).toBe('GET');
  });

  it('query posts JSON to /substrate/v1/query and returns the envelope', async () => {
    const envelope: PackEnvelope = {
      schemaVersion: 'abcdef123456',
      data: { 'cal/Event': [{ id: 1 }] },
      shapes: { 'cal/Event': 'list' }
    };
    stub.next(() => ({ status: 200, body: envelope }));
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    const out = await client.query({
      'cal/Event': { params: { limit: 10 }, fields: { id: true } }
    });
    expect(out).toEqual(envelope);
    expect(stub.calls[0]?.url).toBe('http://cal.internal/substrate/v1/query');
    expect(stub.calls[0]?.method).toBe('POST');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({
      'cal/Event': { params: { limit: 10 }, fields: { id: true } }
    });
  });

  it('mutate posts JSON to /substrate/v1/mutate and returns the envelope', async () => {
    const envelope: PackEnvelope = {
      schemaVersion: 'abcdef123456',
      data: { 'cal/createEvent': { id: 'new-1' } },
      shapes: { 'cal/createEvent': 'single' }
    };
    stub.next(() => ({ status: 200, body: envelope }));
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    const out = await client.mutate({
      'cal/createEvent': { params: { title: 'dinner' }, fields: { id: true } }
    });
    expect(out).toEqual(envelope);
    expect(stub.calls[0]?.url).toBe('http://cal.internal/substrate/v1/mutate');
    expect(stub.calls[0]?.method).toBe('POST');
  });

  it('readRow composes a single-key query and extracts the row', async () => {
    const envelope: PackEnvelope = {
      schemaVersion: 'abcdef123456',
      data: { 'cal/Event': [{ id: 'ev-1', _deletedAt: null }] },
      shapes: { 'cal/Event': 'list' }
    };
    stub.next((_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        'cal/Event': {
          params: { id: 'ev-1', includeDeleted: true },
          fields: { id: true, _deletedAt: true }
        }
      });
      return { status: 200, body: envelope };
    });
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    const row = await client.readRow({ ns: 'cal', type: 'Event', id: 'ev-1' });
    expect(row).toEqual({ id: 'ev-1', _deletedAt: null });
  });

  it('readRow returns null when the response data is empty', async () => {
    const envelope: PackEnvelope = {
      schemaVersion: 'abcdef123456',
      data: { 'cal/Event': [] },
      shapes: { 'cal/Event': 'list' }
    };
    stub.next(() => ({ status: 200, body: envelope }));
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    const row = await client.readRow({ ns: 'cal', type: 'Event', id: 'missing' });
    expect(row).toBeNull();
  });

  it('fetch throw raises BridgeUnreachableError and flips isReachable to false', async () => {
    stub.next(() => new Error('connect ECONNREFUSED'));
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    await expect(client.federatedSchema()).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(client.isReachable()).toBe(false);
  });

  it('a peer that stalls before answering fails as unreachable within timeoutMs', async () => {
    // Honours the signal, as real fetch does, and otherwise never answers.
    const stalled: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stalled,
      healthCheckIntervalMs: 10_000,
      timeoutMs: 20
    });
    await expect(client.query({})).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(client.isReachable()).toBe(false);
  });

  it('a peer that stalls mid-body fails as unreachable within timeoutMs', async () => {
    const stalledBody: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          }
        }),
        { status: 200 }
      );
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stalledBody,
      healthCheckIntervalMs: 10_000,
      timeoutMs: 20
    });
    await expect(client.federatedSchema()).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(client.isReachable()).toBe(false);
  });

  it('refuses redirects and a body past maxResponseBytes', async () => {
    const inits: Array<RequestInit | undefined> = [];
    const big: typeof fetch = async (_input, init) => {
      inits.push(init);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(64).fill(32));
            controller.close();
          }
        }),
        { status: 200 }
      );
    };
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: big,
      healthCheckIntervalMs: 10_000,
      maxResponseBytes: 100
    });
    await expect(client.query({})).rejects.toThrow(/exceeds 100 bytes/);
    expect(inits.every((i) => i?.redirect === 'error')).toBe(true);
  });

  it('5xx status raises BridgeUnreachableError', async () => {
    stub.next(() => ({ status: 503, body: { error: 'unavailable' } }));
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10_000
    });
    await expect(client.query({})).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(client.isReachable()).toBe(false);
  });

  it('isReachable reflects probe verdict over time', async () => {
    // Start with a failing probe, then recover. We drive the probe manually by
    // invoking federatedSchema (which updates #reachable on success/failure).
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 60_000,
      initialReachable: true
    });
    stub.next(() => new Error('boom'));
    await expect(client.federatedSchema()).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(client.isReachable()).toBe(false);

    stub.next(() => ({ status: 200, body: {} }));
    await client.federatedSchema();
    expect(client.isReachable()).toBe(true);
  });

  it('dispose clears the interval and is idempotent', async () => {
    client = new HttpBridgeClient({
      name: 'cal',
      baseUrl: 'http://cal.internal',
      fetch: stub.fetch,
      healthCheckIntervalMs: 10
    });
    // Allow the timer to tick at least once.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30);
      t.unref?.();
    });
    const callsAfterProbe = stub.calls.length;
    client.dispose();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30);
      t.unref?.();
    });
    // Post-dispose: no new probes fire.
    expect(stub.calls.length).toBe(callsAfterProbe);
    client.dispose();
  });
});

describe('auth', () => {
  function captureFetch(): {
    calls: Array<{ url: string; auth: string | undefined }>;
    fetch: typeof fetch;
  } {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get('authorization') ?? undefined });
      return new Response(JSON.stringify({ data: {}, shapes: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;
    return { calls, fetch: f };
  }

  it('attaches Authorization to schema, query, mutate and readRow', async () => {
    const { calls, fetch: f } = captureFetch();
    const client = new HttpBridgeClient({
      name: 'peripheral-a',
      baseUrl: 'http://remote.test',
      fetch: f,
      auth: () => 'Bearer TOKEN-123'
    });

    await client.federatedSchema();
    await client.query({ 'ns/Type': { fields: { id: true } } });
    await client.mutate({ 'ns/createType': { params: {}, fields: { id: true } } });
    await client.readRow({ ns: 'ns', type: 'Type', id: 'row-1' });
    client.dispose();

    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.auth).toBe('Bearer TOKEN-123');
  });

  it('attaches Authorization to the health probe', async () => {
    const { calls, fetch: f } = captureFetch();
    const client = new HttpBridgeClient({
      name: 'peripheral-a',
      baseUrl: 'http://remote.test',
      fetch: f,
      healthCheckIntervalMs: 5,
      auth: () => 'Bearer TOKEN-123'
    });
    await new Promise((r) => setTimeout(r, 20));
    client.dispose();

    const probes = calls.filter((c) => c.url.endsWith('/substrate/v1/federated-schema'));
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) expect(p.auth).toBe('Bearer TOKEN-123');
  });

  it('sends no Authorization when unconfigured', async () => {
    const { calls, fetch: f } = captureFetch();
    const client = new HttpBridgeClient({ name: 'b', baseUrl: 'http://remote.test', fetch: f });
    await client.federatedSchema();
    client.dispose();
    expect(calls[0]?.auth).toBeUndefined();
  });

  it('treats 401 as unreachable so completeness reflects it', async () => {
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const client = new HttpBridgeClient({
      name: 'b',
      baseUrl: 'http://remote.test',
      fetch: f,
      auth: () => 'Bearer X'
    });
    await expect(client.federatedSchema()).rejects.toThrow(/auth/);
    expect(client.isReachable()).toBe(false);
    client.dispose();
  });

  /**
   * 401 and 403 are different claims. 401: the credential is not recognised,
   * so coordinator-wide unreachability is true and useful. 403: authenticated
   * but not permitted THIS operation, which says nothing about the others, so
   * it must not flip `#reachable` (that would short-circuit every later read).
   *
   * The refused call still throws `BridgeUnreachableError`; only the shared
   * flag is left alone. A credential that cannot read is still caught by the
   * health probe, which sets `#reachable = res.ok`.
   */
  it('does not mark the bridge unreachable on 403 — the peer answered', async () => {
    const f = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    const client = new HttpBridgeClient({
      name: 'b',
      baseUrl: 'http://remote.test',
      fetch: f,
      auth: () => 'Bearer X',
      healthCheckIntervalMs: 60_000
    });
    await expect(client.mutate({})).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(client.isReachable()).toBe(true);
    client.dispose();
  });

  it('still tags a 403 as an auth failure so the refused call reports it', async () => {
    const f = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    const client = new HttpBridgeClient({
      name: 'b',
      baseUrl: 'http://remote.test',
      fetch: f,
      auth: () => 'Bearer X',
      healthCheckIntervalMs: 60_000
    });
    await expect(client.mutate({})).rejects.toThrow(/auth/);
    client.dispose();
  });

  it('a 403 on one call leaves a later authorised call able to reach the peer', async () => {
    const stub2 = mkFetch();
    const client = new HttpBridgeClient({
      name: 'b',
      baseUrl: 'http://remote.test',
      fetch: stub2.fetch,
      auth: () => 'Bearer X',
      healthCheckIntervalMs: 60_000
    });
    stub2.next(() => ({ status: 403, body: {} }));
    await expect(client.mutate({})).rejects.toBeInstanceOf(BridgeUnreachableError);

    // The whole point: reachability is untouched, so the engine's
    // `isUnreachable` short-circuit does not fire and this read goes out.
    expect(client.isReachable()).toBe(true);
    stub2.next(() => ({ status: 200, body: { data: {}, shapes: {} } }));
    await expect(client.query({})).resolves.toBeDefined();
    client.dispose();
  });
});
