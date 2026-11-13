/**
 * SubstrateClient against a real HTTP/2-only server: it negotiates h2 over TLS
 * and h2c, multiplexes its subscriptions on one session, keeps a stalled
 * subscriber from holding up its siblings, and rides out a server restart.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { TlsConfig } from '@mnmal-ai/substrate-types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createH2Fetch, type FetchLike, SubstrateClient } from '../src/index.js';
import type { SubscribeEvent } from '../src/transport/frame-event.js';
import { demoPlugin } from './fixtures/demo-plugin.js';

const TODO = { 'default/Todo': { params: {}, fields: { id: true, title: true } } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway self-signed certificate for 127.0.0.1. */
function selfSigned(): TlsConfig & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-h2-parity-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  );
  return {
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    dir
  };
}

interface Started {
  baseUrl: string;
  port: number;
  composed: ComposeResult;
  /** `httpVersion` of every request the server saw. */
  versions: string[];
  /** HTTP/2 sessions the server accepted. */
  sessions: () => number;
}

async function serve(opts: { tls?: TlsConfig; port?: number } = {}): Promise<Started> {
  const server = new FastifySubstrateServer({
    logger: false,
    ...(opts.tls !== undefined ? { tls: opts.tls } : {})
  });
  const versions: string[] = [];
  let sessions = 0;
  const { fastify } = server as unknown as {
    fastify: {
      server: NodeJS.EventEmitter;
      addHook(n: 'onRequest', h: (req: { raw: { httpVersion: string } }) => Promise<void>): void;
    };
  };
  fastify.addHook('onRequest', async (req) => {
    versions.push(req.raw.httpVersion);
  });
  fastify.server.on('session', () => {
    sessions++;
  });
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    coordinators: [demoPlugin]
  });
  const { port } = await server.start({ host: '127.0.0.1', port: opts.port ?? 0 });
  let stopped = false;
  cleanups.push(async () => {
    if (!stopped) await composed.stop();
  });
  const stop = composed.stop.bind(composed);
  composed.stop = async () => {
    stopped = true;
    await stop();
  };
  const scheme = opts.tls !== undefined ? 'https' : 'http';
  return {
    baseUrl: `${scheme}://127.0.0.1:${port}`,
    port,
    composed,
    versions,
    sessions: () => sessions
  };
}

function client(baseUrl: string, fetch?: FetchLike): SubstrateClient {
  const c = new SubstrateClient({ endpoint: baseUrl, ...(fetch !== undefined ? { fetch } : {}) });
  cleanups.push(() => c.close());
  return c;
}

async function next(it: AsyncIterator<SubscribeEvent>): Promise<SubscribeEvent> {
  const r = await it.next();
  if (r.done === true) throw new Error('subscription ended');
  return r.value;
}

const createTodo = (c: SubstrateClient, title: string) =>
  c.mutate({ 'default/createTodo': { params: { title }, fields: { id: true } } });

describe('SubstrateClient over HTTP/2', () => {
  const tls = hasOpenssl() ? selfSigned() : undefined;
  afterAll(() => {
    if (tls !== undefined) rmSync(tls.dir, { recursive: true, force: true });
  });

  it('negotiates h2 in cleartext (h2c)', async () => {
    const s = await serve();
    await client(s.baseUrl).query(TODO);
    expect(s.versions.length).toBeGreaterThan(0);
    expect(new Set(s.versions)).toEqual(new Set(['2.0']));
  });

  it.skipIf(tls === undefined)('negotiates h2 over TLS', async () => {
    const t = tls as TlsConfig;
    const s = await serve({ tls: t });
    const f = createH2Fetch({ ca: t.cert });
    cleanups.push(() => f.close());
    await client(s.baseUrl, f).query(TODO);
    expect(new Set(s.versions)).toEqual(new Set(['2.0']));
  });

  it('twenty concurrent subscriptions share one session and each gets snapshot and deltas', async () => {
    const s = await serve();
    const f = createH2Fetch();
    cleanups.push(() => f.close());
    const c = client(s.baseUrl, f);
    const its = Array.from({ length: 20 }, () => c.subscribe(TODO)[Symbol.asyncIterator]());
    for (const it of its) expect((await next(it)).kind).toBe('snapshot');
    expect(s.composed.engine.activeSubscriptionCount()).toBe(20);
    await createTodo(c, 'fan-out');
    for (const ev of await Promise.all(its.map(next)))
      expect(ev).toMatchObject({ kind: 'add', data: { 'default/Todo': { title: 'fan-out' } } });
    expect(s.sessions()).toBe(1);
    await Promise.all(its.map((it) => it.return?.()));
  });

  it('a subscriber that never reads does not delay a sibling past 500 ms', async () => {
    const s = await serve();
    const c = client(s.baseUrl);
    const stalled = c.subscribe(TODO)[Symbol.asyncIterator]();
    const live = c.subscribe(TODO)[Symbol.asyncIterator]();
    await next(stalled);
    await next(live);
    // Enough bytes to the stalled stream to fill a default 64 KiB flow-control window.
    const big = 'x'.repeat(4096);
    for (let i = 0; i < 40; i++) {
      await createTodo(c, `${i}-${big}`);
      await next(live);
    }
    const t0 = performance.now();
    await createTodo(c, 'last');
    expect(await next(live)).toMatchObject({
      kind: 'add',
      data: { 'default/Todo': { title: 'last' } }
    });
    expect(performance.now() - t0).toBeLessThan(500);
    await stalled.return?.();
    await live.return?.();
  });

  it('stop() ends a live stream with server_restart; the client re-snapshots from the restarted server', async () => {
    const a = await serve();
    const c = client(a.baseUrl);
    await createTodo(c, 'on-a');
    const it = c.subscribe(TODO)[Symbol.asyncIterator]();
    expect(await next(it)).toMatchObject({
      kind: 'snapshot',
      data: { 'default/Todo': [{ title: 'on-a' }] }
    });
    await a.composed.stop();
    expect(await next(it)).toMatchObject({ kind: 'end', reason: 'server_restart' });
    const b = await serve({ port: a.port });
    await createTodo(client(b.baseUrl), 'on-b');
    expect(await next(it)).toMatchObject({
      kind: 'snapshot',
      data: { 'default/Todo': [{ title: 'on-b' }] }
    });
    await it.return?.();
  }, 20_000);
});
