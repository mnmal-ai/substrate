/**
 * SubstrateClient subscribe / stream / watch over length-prefixed frame
 * streams. Happy paths run against a real FastifySubstrateServer; the
 * failure modes run against a scripted node:http server, where each request's
 * frames are chosen by the test.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { encodeStreamFrame, FRAMES_JSON_MIME, FRAMES_PACK_MIME } from '@mnmal-ai/substrate-pack';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, NetworkError, SubscribeError, SubstrateClient } from '../src/index.js';
import type { SubscribeEvent } from '../src/transport/frame-event.js';
import { demoPlugin } from './fixtures/demo-plugin.js';

const TODO = { 'default/Todo': { params: {}, fields: { id: true, title: true } } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function realServer(): Promise<{ baseUrl: string; composed: ComposeResult }> {
  const server = new FastifySubstrateServer({ logger: false });
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    coordinators: [demoPlugin]
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => composed.stop());
  return { baseUrl: `http://127.0.0.1:${port}`, composed };
}

function client(
  baseUrl: string,
  opts: Partial<ConstructorParameters<typeof SubstrateClient>[0]> = {}
) {
  const c = new SubstrateClient({ endpoint: baseUrl, ...opts });
  cleanups.push(() => c.close());
  return c;
}

async function take(it: AsyncIterator<SubscribeEvent>, n: number): Promise<SubscribeEvent[]> {
  const out: SubscribeEvent[] = [];
  for (let i = 0; i < n; i++) {
    const r = await it.next();
    if (r.done === true) break;
    out.push(r.value);
  }
  return out;
}

const createTodo = (c: SubstrateClient, title: string) =>
  c.mutate({ 'default/createTodo': { params: { title }, fields: { id: true } } });

describe('frames against a real server', () => {
  it.each(['json', 'pack'] as const)('subscribe yields snapshot then deltas (%s)', async (wire) => {
    const { baseUrl } = await realServer();
    const c = client(baseUrl, { streamWire: wire });
    await createTodo(c, 'before');
    const it = c.subscribe(TODO)[Symbol.asyncIterator]();
    const [snapshot] = await take(it, 1);
    expect(snapshot).toMatchObject({
      kind: 'snapshot',
      data: { 'default/Todo': [{ id: expect.any(String), title: 'before' }] }
    });
    await createTodo(c, 'after');
    expect((await take(it, 1))[0]).toMatchObject({
      kind: 'add',
      data: { 'default/Todo': { title: 'after' } }
    });
    await it.return?.();
  });

  it('ten concurrent subscriptions on one client all receive their deltas', async () => {
    const { baseUrl, composed } = await realServer();
    const c = client(baseUrl);
    const its = Array.from({ length: 10 }, () => c.subscribe(TODO)[Symbol.asyncIterator]());
    for (const it of its) expect((await take(it, 1))[0]?.kind).toBe('snapshot');
    expect(composed.engine.activeSubscriptionCount()).toBe(10);
    await createTodo(c, 'fan-out');
    const adds = await Promise.all(its.map((it) => take(it, 1)));
    for (const [ev] of adds)
      expect(ev).toMatchObject({ kind: 'add', data: { 'default/Todo': { title: 'fan-out' } } });
    await Promise.all(its.map((it) => it.return?.()));
  });

  it('watch() keeps its contract: the row set after each delta', async () => {
    const { baseUrl } = await realServer();
    const c = client(baseUrl);
    const it = c.watch<{ id: string; title: string }>(TODO)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual([]);
    await createTodo(c, 'watched');
    expect((await it.next()).value).toEqual([{ id: expect.any(String), title: 'watched' }]);
    await it.return?.();
  });

  it('return() reaches the server: the engine subscription ends', async () => {
    const { baseUrl, composed } = await realServer();
    const it = client(baseUrl).subscribe(TODO)[Symbol.asyncIterator]();
    await take(it, 1);
    expect(composed.engine.activeSubscriptionCount()).toBe(1);
    await it.return?.();
    await expect.poll(() => composed.engine.activeSubscriptionCount()).toBe(0);
  });

  it('close() ends every open subscription', async () => {
    const { baseUrl } = await realServer();
    const c = new SubstrateClient({ endpoint: baseUrl });
    const it = c.subscribe(TODO)[Symbol.asyncIterator]();
    await take(it, 1);
    const pending = it.next();
    await c.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });
});

/** One scripted response per request, by request number (1-based). */
type Script = (n: number, res: http.ServerResponse, req: http.IncomingMessage) => void;

async function scripted(
  script: Script
): Promise<{ baseUrl: string; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/substrate/v1/federated-schema') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SCHEMA));
      return;
    }
    requests.push(req);
    script(requests.length, res, req);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const SCHEMA = {
  default: {
    name: 'default',
    version: '1',
    types: {
      Todo: {
        name: 'Todo',
        fields: {
          id: { kind: 'scalar', type: 'string' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    },
    mutations: {}
  }
};

function open(res: http.ServerResponse, mime = FRAMES_JSON_MIME): void {
  res.writeHead(200, { 'content-type': mime });
}
function send(
  res: http.ServerResponse,
  frame: Record<string, unknown>,
  wire: 'json' | 'pack' = 'json'
): void {
  res.write(encodeStreamFrame({ id: 'frames-subscribe', ...frame }, wire));
}
const snapshot = (title: string) => ({
  kind: 'snapshot',
  data: { 'default/Todo': [{ id: '1', title }] }
});
const FAST = { baseDelayMs: 5, maxDelayMs: 20, jitter: 0 };

describe('frames against a scripted server', () => {
  it('end{server_restart} resubscribes at once and yields a fresh snapshot', async () => {
    const { baseUrl } = await scripted((n, res) => {
      open(res);
      send(res, snapshot(`s${n}`));
      if (n === 1)
        res.end(
          encodeStreamFrame({ id: 'x', kind: 'end', reason: 'server_restart', final: true }, 'json')
        );
    });
    const it = client(baseUrl).subscribe(TODO)[Symbol.asyncIterator]();
    expect(await take(it, 3)).toEqual([
      { kind: 'snapshot', data: { 'default/Todo': [{ id: '1', title: 's1' }] } },
      { kind: 'end', final: true, reason: 'server_restart' },
      { kind: 'snapshot', data: { 'default/Todo': [{ id: '1', title: 's2' }] } }
    ]);
    await it.return?.();
  });

  it('a network drop backs off, then re-snapshots', async () => {
    const { baseUrl, requests } = await scripted((n, res) => {
      open(res);
      send(res, snapshot(`s${n}`));
      if (n === 1) setTimeout(() => res.destroy(), 10);
    });
    const it = client(baseUrl, { reconnect: FAST }).subscribe(TODO)[Symbol.asyncIterator]();
    const got = await take(it, 2);
    expect(
      got.map(
        (e) =>
          (e as { data: Record<string, Array<{ title: string }>> }).data['default/Todo']?.[0]?.title
      )
    ).toEqual(['s1', 's2']);
    expect(requests).toHaveLength(2);
    await it.return?.();
  });

  it('subscription_overloaded resubscribes after the overload delay, unseen by the consumer', async () => {
    const { baseUrl } = await scripted((n, res) => {
      open(res);
      send(res, snapshot(`s${n}`));
      if (n === 1) {
        send(res, {
          kind: 'error',
          errors: [{ code: 'subscription_overloaded', message: 'full' }]
        });
        res.end(
          encodeStreamFrame(
            { id: 'x', kind: 'end', reason: 'subscription_overloaded', final: true },
            'json'
          )
        );
      }
    });
    const c = client(baseUrl, { overloadResubscribe: { baseDelayMs: 5, jitter: 0 } });
    const it = c.subscribe(TODO)[Symbol.asyncIterator]();
    expect((await take(it, 2)).map((e) => e.kind)).toEqual(['snapshot', 'snapshot']);
    await it.return?.();
  });

  it('with overload resubscribe disabled, the overload is a SubscribeError and nothing is re-sent', async () => {
    const { baseUrl, requests } = await scripted((_n, res) => {
      open(res);
      send(res, snapshot('s'));
      send(res, { kind: 'error', errors: [{ code: 'subscription_overloaded', message: 'full' }] });
      res.end();
    });
    const it = client(baseUrl, { overloadResubscribe: { enabled: false } })
      .subscribe(TODO)
      [Symbol.asyncIterator]();
    await take(it, 1);
    await expect(it.next()).rejects.toBeInstanceOf(SubscribeError);
    expect(requests).toHaveLength(1);
  });

  it('401 is terminal: AuthError, no retry loop', async () => {
    const { baseUrl, requests } = await scripted((_n, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'unauthorized', message: 'unauthorized' }] }));
    });
    const it = client(baseUrl, { token: 'bad', reconnect: FAST })
      .subscribe(TODO)
      [Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(AuthError);
    expect(requests).toHaveLength(1);
  });

  it('a server that answers SSE is refused at once, not retried', async () => {
    const { baseUrl, requests } = await scripted((_n, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('retry: 5000\n\n');
    });
    const it = client(baseUrl, { reconnect: FAST }).subscribe(TODO)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({
      name: 'NetworkError',
      code: 'frames_unsupported'
    });
    expect(requests).toHaveLength(1);
  });

  it('a stream that drops mid-way throws rather than replaying its chunks', async () => {
    const { baseUrl, requests } = await scripted((_n, res) => {
      open(res);
      res.write(
        encodeStreamFrame({ id: 'frames-stream', kind: 'chunk', data: {}, sequence: 0 }, 'json')
      );
      setTimeout(() => res.destroy(), 10);
    });
    const it = client(baseUrl, { reconnect: FAST }).stream(TODO)[Symbol.asyncIterator]();
    expect((await it.next()).value?.kind).toBe('chunk');
    await expect(it.next()).rejects.toBeInstanceOf(NetworkError);
    expect(requests).toHaveLength(1);
  });

  it('getToken returning undefined sends no Authorization header', async () => {
    const { baseUrl, requests } = await scripted((_n, res) => {
      open(res);
      send(res, snapshot('s'));
    });
    const it = client(baseUrl, { getToken: () => undefined })
      .subscribe(TODO)
      [Symbol.asyncIterator]();
    await take(it, 1);
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.headers.accept).toBe(FRAMES_JSON_MIME);
    await it.return?.();
  });

  it('pack: return() on a quiet subscription resolves at once and closes the request', async () => {
    let closed = false;
    const { baseUrl } = await scripted((_n, res, req) => {
      req.on('close', () => {
        closed = true;
      });
      open(res, FRAMES_PACK_MIME);
      send(res, { kind: 'snapshot', data: { 'default/Todo': [['1', 'packed']] } }, 'pack');
    });
    const it = client(baseUrl, { streamWire: 'pack' }).subscribe(TODO)[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({
      kind: 'snapshot',
      data: { 'default/Todo': [{ id: '1', title: 'packed' }] }
    });
    // A second next() parks on the quiet body: the case a native generator would hang on.
    void it.next();
    await new Promise((r) => setTimeout(r, 20));
    const outcome = await Promise.race([
      (it.return?.() ?? Promise.resolve()).then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('timeout'), 1000))
    ]);
    expect(outcome).toBe('returned');
    await expect.poll(() => closed).toBe(true);
  });
});
