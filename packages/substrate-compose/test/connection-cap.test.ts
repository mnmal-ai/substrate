import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  Identity,
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_RECHECK_MS, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import {
  createConnectionLimiter,
  MAX_CONNECTIONS_PER_CLIENT
} from '../src/routes/connection-limit.js';
import { extractClientIp, ipCapKey } from '../src/routes/helpers.js';
import { registerWsRoute } from '../src/routes/ws.js';

const SECRET = 'connection-cap-test-secret-0123456789';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('per-client connection cap', () => {
  it('caps WS sockets and SSE streams together per identity, and frees a slot on close', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: { keys: [{ kid: 'k', alg: 'HS256', publicKey: SECRET }] },
      streamTicketSecret: 'connection-cap-stream-secret'
    });
    await server.start();
    stop = () => composed.stop();
    const token = (sub: string) =>
      signHs256({ sub, exp: Math.floor(Date.now() / 1000) + 60, capabilities: ['read'] }, SECRET, {
        kid: 'k'
      });
    const headers = { authorization: `Bearer ${token('a')}` };
    const open = async (h = headers) => {
      const client = server.connectWebsocket('/substrate/v1/ws', h);
      const codes: Array<number | undefined> = [];
      client.onClose((code) => codes.push(code));
      await tick();
      return { client, codes };
    };

    const sockets = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_CLIENT; i++) sockets.push(await open());
    expect(sockets.every((s) => s.codes.length === 0)).toBe(true);

    expect((await open()).codes).toEqual([1013]);
    const sse = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      headers: { ...headers, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Nothing': { fields: { id: true } } }))
    });
    expect(sse.status).toBe(429);
    // Another identity is unaffected.
    expect((await open({ authorization: `Bearer ${token('b')}` })).codes).toEqual([]);

    sockets[0]?.client.close();
    await tick();
    expect((await open()).codes).toEqual([]);
  });
  it('holds an aborted SSE stream slot until its snapshot read settles', async () => {
    const { server, headers, openGate, abortedSubscribe } = await gatedSse();
    const wsCodes = async () => {
      const client = server.connectWebsocket('/substrate/v1/ws', headers);
      const codes: Array<number | undefined> = [];
      client.onClose((code) => codes.push(code));
      await tick();
      const seen = [...codes];
      client.close();
      await tick();
      return seen;
    };

    const pending = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_CLIENT; i++)
      pending.push((await abortedSubscribe()).done);
    await tick();
    expect(await wsCodes()).toEqual([1013]);

    openGate();
    await Promise.allSettled(pending);
    await tick();
    expect(await wsCodes()).toEqual([]);
  });

  it('arms no credential re-check for an SSE stream aborted during start', async () => {
    const live = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const t = realSet(fn, ms);
      if (ms === CREDENTIAL_RECHECK_MS) live.add(t);
      return t;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      t?: Parameters<typeof clearInterval>[0]
    ) => {
      live.delete(t);
      realClear(t);
    }) as typeof clearInterval);
    try {
      const { openGate, abortedSubscribe } = await gatedSse();
      const pending = [(await abortedSubscribe()).done, (await abortedSubscribe()).done];
      openGate();
      await Promise.allSettled(pending);
      await tick();
      expect(live.size).toBe(0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

/** A composed server whose snapshot reads park until `openGate`, plus an SSE subscribe aborted mid-read. */
async function gatedSse() {
  let openGate = (): void => {};
  const gate = new Promise<void>((r) => {
    openGate = r;
  });
  let armed = false;
  class GatedDataset extends MemoryDataset {
    override async read(...args: Parameters<MemoryDataset['read']>) {
      if (armed) await gate;
      return super.read(...args);
    }
  }
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new GatedDataset({ namespace: 'default' }),
    auth: { keys: [{ kid: 'k', alg: 'HS256', publicKey: SECRET }] },
    streamTicketSecret: 'connection-cap-stream-secret',
    coordinators: [
      {
        name: 'w',
        contractVersion: '*',
        namespaces: [defineNamespace('default', { Widget: { fields: { label: field.string() } } })]
      }
    ]
  });
  await server.start();
  stop = () => composed.stop();
  const token = signHs256(
    { sub: 'a', exp: Math.floor(Date.now() / 1000) + 60, capabilities: ['read'] },
    SECRET,
    { kid: 'k' }
  );
  const headers = { authorization: `Bearer ${token}` };
  armed = true;
  const abortedSubscribe = async () => {
    const ac = new AbortController();
    const res = server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      signal: ac.signal,
      headers: { ...headers, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Widget': { fields: { id: true } } }))
    });
    await tick();
    ac.abort();
    // Wrapped so awaiting the abort doesn't also await the response.
    return { done: res };
  };
  return { server, headers, openGate, abortedSubscribe };
}

describe('connection cap keys', () => {
  it('keys IPv6 by its /64 and IPv4-mapped IPv6 as IPv4', () => {
    expect(ipCapKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipCapKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(ipCapKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipCapKey('::1')).toBe('0:0:0:0::/64');
    expect(ipCapKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipCapKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(ipCapKey('::ffff:a00:1')).toBe('10.0.0.1');
    expect(ipCapKey('::10.0.0.1')).toBe('10.0.0.1');
    expect(ipCapKey('10.0.0.1')).toBe('10.0.0.1');
    expect(ipCapKey('unknown')).toBe('unknown');

    const limiter = createConnectionLimiter(1);
    expect(limiter.acquire(null, '2001:db8:1:2::1')).not.toBeNull();
    expect(limiter.acquire(null, '2001:db8:1:2::2')).toBeNull();
    expect(limiter.acquire(null, '2001:db8:1:3::1')).not.toBeNull();
  });

  it('does not bucket together anonymous callers with no known IP', () => {
    const limiter = createConnectionLimiter(1);
    expect(limiter.acquire(null, undefined)).not.toBeNull();
    expect(limiter.acquire(null, undefined)).not.toBeNull();
  });

  it('gives auth-off sockets on different IPs separate buckets', async () => {
    let handler: WsHandler | undefined;
    const server = {
      route: () => {},
      websocket: (_path: string, h: WsHandler) => {
        handler = h;
      }
    } as unknown as SubstrateServer;
    const engine = new Engine({
      namespaces: new Map(),
      datasets: new MemoryDatasetRegistry(),
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
    // Auth off: every socket carries the same system identity.
    registerWsRoute(
      server,
      engine,
      new Set(),
      () => {},
      undefined,
      { kind: 'system', id: 'system', grants: { '*': ['read'] } } as Identity,
      createConnectionLimiter(1)
    );
    const connect = async (peerIp: string) => {
      const closed: Array<number | undefined> = [];
      const conn = {
        id: peerIp,
        send: () => {},
        onMessage: () => {},
        onClose: () => {},
        close: (code?: number) => closed.push(code)
      } as unknown as WsConnection;
      const req = {
        method: 'GET',
        path: '/substrate/v1/ws',
        headers: {},
        query: {},
        params: {},
        body: null,
        peerIp
      } as unknown as SubstrateRequest;
      await handler?.(req, conn);
      return closed;
    };
    expect(await connect('10.0.0.1')).toEqual([]);
    expect(await connect('10.0.0.2')).toEqual([]);
    expect(await connect('10.0.0.1')).toEqual([1013]);
  });
});

describe('per-client session cap', () => {
  it('counts sessions across sockets, refuses past the cap, and frees a slot on cancel', async () => {
    let handler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler) => {
        handler = h;
      }
    } as unknown as SubstrateServer;
    const registry = new Registry();
    registry.register('Memo', { resolver: async () => [] });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', new MemoryDataset({ namespace: 'default' }));
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
    registerWsRoute(
      server,
      engine,
      new Set(),
      () => {},
      undefined,
      { kind: 'system', id: 'system', grants: { '*': ['read'] } } as Identity,
      undefined,
      createConnectionLimiter(2)
    );
    const connect = async () => {
      const frames: WsResponseFrame[] = [];
      let onMsg: ((b: Buffer) => void) | undefined;
      const conn = {
        id: 'c',
        send: (f: string | Buffer) => frames.push(JSON.parse(String(f))),
        onMessage: (cb: (b: Buffer) => void) => {
          onMsg = cb;
        },
        onClose: () => {},
        close: () => {}
      } as unknown as WsConnection;
      const req = {
        method: 'GET',
        path: '/substrate/v1/ws',
        headers: {},
        query: {},
        params: {},
        body: null,
        peerIp: '10.0.0.1'
      } as unknown as SubstrateRequest;
      await handler?.(req, conn);
      const send = async (frame: unknown) => {
        onMsg?.(Buffer.from(JSON.stringify(frame)));
        for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      };
      return { frames, send };
    };
    const subscribe = (id: string) => ({
      id,
      op: 'subscribe',
      frame: { 'default/Memo': { fields: { id: true } } }
    });
    const refused = (frames: WsResponseFrame[], id: string) =>
      frames.some((f) => f.id === id && f.errors?.[0]?.code === 'too_many_sessions');

    const a = await connect();
    const b = await connect();
    await a.send(subscribe('a1'));
    await b.send(subscribe('b1'));
    await b.send(subscribe('b2'));
    expect(refused(a.frames, 'a1') || refused(b.frames, 'b1')).toBe(false);
    expect(refused(b.frames, 'b2')).toBe(true);

    await a.send({ id: 'a1', op: 'cancel' });
    await b.send(subscribe('b3'));
    expect(refused(b.frames, 'b3')).toBe(false);
  });
  it('holds a cancelled session slot until its snapshot read settles', async () => {
    let handler: WsHandler | undefined;
    const server = {
      websocket: (_path: string, h: WsHandler) => {
        handler = h;
      }
    } as unknown as SubstrateServer;
    let openGate = (): void => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const registry = new Registry();
    registry.register('Memo', {
      resolver: async () => {
        await gate;
        return [];
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', new MemoryDataset({ namespace: 'default' }));
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
    registerWsRoute(
      server,
      engine,
      new Set(),
      () => {},
      undefined,
      { kind: 'system', id: 'system', grants: { '*': ['read'] } } as Identity,
      undefined,
      createConnectionLimiter(1)
    );
    const frames: WsResponseFrame[] = [];
    let onMsg: ((b: Buffer) => void) | undefined;
    const conn = {
      id: 'c',
      send: (f: string | Buffer) => frames.push(JSON.parse(String(f))),
      onMessage: (cb: (b: Buffer) => void) => {
        onMsg = cb;
      },
      onClose: () => {},
      close: () => {}
    } as unknown as WsConnection;
    await handler?.(
      {
        method: 'GET',
        path: '/substrate/v1/ws',
        headers: {},
        query: {},
        params: {},
        body: null,
        peerIp: '10.0.0.1'
      } as unknown as SubstrateRequest,
      conn
    );
    const send = async (frame: unknown) => {
      onMsg?.(Buffer.from(JSON.stringify(frame)));
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };
    const subscribe = (id: string) => ({
      id,
      op: 'subscribe',
      frame: { 'default/Memo': { fields: { id: true } } }
    });
    const refused = (id: string) =>
      frames.some((f) => f.id === id && f.errors?.[0]?.code === 'too_many_sessions');

    await send(subscribe('s1'));
    await send({ id: 's1', op: 'cancel' });
    await send(subscribe('s2'));
    expect(refused('s2')).toBe(true);

    openGate();
    await send({ id: 'noop', op: 'cancel' });
    await send(subscribe('s3'));
    expect(refused('s3')).toBe(false);
  });
});

describe('client address behind a trusted proxy', () => {
  const via = (xff: string): string | undefined =>
    extractClientIp(
      { peerIp: '10.0.0.9', headers: { 'x-forwarded-for': xff } } as never,
      new Set(['10.0.0.9'])
    );

  it('drops the port and brackets a proxy appends', () => {
    expect(via('1.2.3.4:5555')).toBe('1.2.3.4');
    expect(via('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(via('[::1]')).toBe('::1');
  });

  it('falls back to the proxy when the nearest hop is not an address, never to entries left of it', () => {
    expect(via('6.6.6.6, not-an-ip')).toBe('10.0.0.9');
  });
});
