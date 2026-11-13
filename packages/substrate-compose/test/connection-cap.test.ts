import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { Identity, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_RECHECK_MS, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import {
  createConnectionLimiter,
  MAX_CONNECTIONS_PER_CLIENT
} from '../src/routes/connection-limit.js';
import { extractClientIp, ipCapKey } from '../src/routes/helpers.js';
import { registerStreamRoutes } from '../src/routes/stream-routes.js';

const SECRET = 'connection-cap-test-secret-0123456789';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

const widgetPlugin = {
  name: 'w',
  contractVersion: '*',
  namespaces: [defineNamespace('default', { Widget: { fields: { label: field.string() } } })]
};

const subscribeWidgets = (server: MemorySubstrateServer, headers: Record<string, string>) =>
  server.inject({
    method: 'POST',
    path: '/substrate/v1/subscribe',
    headers: { ...headers, 'content-type': 'application/json', accept: FRAMES_JSON_MIME },
    body: Buffer.from(JSON.stringify({ 'default/Widget': { fields: { id: true } } }))
  });

const errorCode = (res: SubstrateResponse) =>
  (JSON.parse(String(res.body)) as { errors: Array<{ code: string }> }).errors[0]?.code;

describe('per-client connection cap', () => {
  it('caps frames streams per identity, and frees a slot on close', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: { keys: [{ kid: 'k', alg: 'HS256', publicKey: SECRET }] },
      coordinators: [widgetPlugin]
    });
    await server.start();
    stop = () => composed.stop();
    const token = (sub: string) =>
      signHs256({ sub, exp: Math.floor(Date.now() / 1000) + 60, capabilities: ['read'] }, SECRET, {
        kid: 'k'
      });
    const headers = { authorization: `Bearer ${token('a')}` };

    const streams: SubstrateResponse[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_CLIENT; i++)
      streams.push(await subscribeWidgets(server, headers));
    expect(streams.every((s) => s.status === 200)).toBe(true);

    const refused = await subscribeWidgets(server, headers);
    expect(refused.status).toBe(429);
    expect(errorCode(refused)).toBe('too_many_connections');
    // Another identity is unaffected.
    const other = await subscribeWidgets(server, { authorization: `Bearer ${token('b')}` });
    expect(other.status).toBe(200);
    await (other.body as ReadableStream<Uint8Array>).cancel();

    await (streams[0]?.body as ReadableStream<Uint8Array> | undefined)?.cancel();
    await tick();
    const reopened = await subscribeWidgets(server, headers);
    expect(reopened.status).toBe(200);
    await (reopened.body as ReadableStream<Uint8Array>).cancel();
  });

  it('holds an aborted stream slot until its snapshot read settles', async () => {
    const { server, headers, openGate, abortedSubscribe } = await gatedStream();

    const pending = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_CLIENT; i++)
      pending.push((await abortedSubscribe()).done);
    await tick();
    // Refused before any read, so the gated dataset cannot park this probe.
    const refused = await subscribeWidgets(server, headers);
    expect(refused.status).toBe(429);
    expect(errorCode(refused)).toBe('too_many_connections');

    openGate();
    await Promise.allSettled(pending);
    await tick();
    const admitted = await subscribeWidgets(server, headers);
    expect(admitted.status).toBe(200);
    await (admitted.body as ReadableStream<Uint8Array>).cancel();
  });

  it('arms no credential re-check for a stream aborted during start', async () => {
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
      const { openGate, abortedSubscribe } = await gatedStream();
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

/** A composed server whose snapshot reads park until `openGate`, plus a frames subscribe aborted mid-read. */
async function gatedStream() {
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
    coordinators: [widgetPlugin]
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
      headers: { ...headers, 'content-type': 'application/json', accept: FRAMES_JSON_MIME },
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

  it('gives auth-off streams on different IPs separate buckets', async () => {
    const server = new MemorySubstrateServer();
    registerStreamRoutes(
      server,
      openEngine(),
      new Set(),
      (h) => h,
      () => {},
      undefined,
      createConnectionLimiter(1)
    );
    const status = async (peerIp: string) => (await openStream(server, peerIp)).status;
    expect(await status('10.0.0.1')).toBe(200);
    expect(await status('10.0.0.2')).toBe(200);
    expect(await status('10.0.0.1')).toBe(429);
  });
});

/** An engine double whose sessions register and then stay open. */
function openEngine(): never {
  const handle = (input: { id: string }) => ({ id: input.id, cancel: () => {} });
  return { subscribe: async (input: { id: string }) => handle(input), stream: handle } as never;
}

/** Auth off: every request carries the same system identity, as compose's gate stamps it. */
const SYSTEM = { kind: 'system', id: 'system', grants: { '*': ['read'] } } as Identity;

const openStream = (server: MemorySubstrateServer, peerIp: string) =>
  server.inject({
    method: 'POST',
    path: '/substrate/v1/subscribe',
    peerIp,
    identity: SYSTEM,
    headers: { accept: FRAMES_JSON_MIME },
    body: Buffer.from(JSON.stringify({ 'default/Memo': { fields: { id: true } } }))
  });

describe('refused requests hold no slot', () => {
  it('a 406 or 400 before the stream opens leaves the cap untouched', async () => {
    const server = new MemorySubstrateServer();
    registerStreamRoutes(
      server,
      openEngine(),
      new Set(),
      (h) => h,
      () => {},
      undefined,
      createConnectionLimiter(1)
    );
    const send = (accept: string, body: string) =>
      server.inject({
        method: 'POST',
        path: '/substrate/v1/subscribe',
        peerIp: '10.0.0.1',
        headers: { accept },
        body: Buffer.from(body)
      });
    for (let i = 0; i < 3; i++) {
      expect((await send('text/event-stream', '{}')).status).toBe(406);
      expect((await send(FRAMES_JSON_MIME, 'not json')).status).toBe(400);
    }
    expect((await openStream(server, '10.0.0.1')).status).toBe(200);
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
