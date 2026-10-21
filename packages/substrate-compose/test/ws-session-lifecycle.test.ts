/**
 * Session bookkeeping on the kernel `/substrate/v1/ws` route: one socket's id
 * map, who an auth-off socket acts as, and the end of a session whose
 * credential lapses while it is open.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  Identity,
  Resolver,
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthConfig, CREDENTIAL_RECHECK_MS, signHs256 } from '../src/auth.js';
import { type ConnectionLimiter, createConnectionLimiter } from '../src/routes/connection-limit.js';
import { registerWsRoute } from '../src/routes/ws.js';

const SECRET = 'ws-session-lifecycle-test-secret-0123456789';
const AUTH: AuthConfig = { keys: [{ kid: 'k1', alg: 'HS256', publicKey: SECRET }] };

function buildEngine(seen: Array<Identity | null>): Engine {
  const echo: Resolver = async function* (ctx) {
    seen.push(ctx.identity);
    yield { id: 'r1' };
  };
  const registry = new Registry();
  registry.register('Memo', { resolver: async () => [{ id: 'm1' }] });
  registry.register('echo', { resolver: echo });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  return new Engine({
    namespaces: new Map([['default', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-10-19T00:00:00Z') })
  });
}

interface Socket {
  frames: WsResponseFrame[];
  closed: Array<number | undefined>;
  send(frame: unknown): void;
  disconnect(): void;
}

async function open(
  opts: {
    auth?: AuthConfig;
    systemIdentity?: Identity;
    token?: string;
    seen?: Array<Identity | null>;
    sessionCap?: ConnectionLimiter;
  } = {}
): Promise<Socket> {
  let handler: WsHandler | undefined;
  const server = {
    websocket: (_p: string, h: WsHandler): void => {
      handler = h;
    }
  } as unknown as SubstrateServer;
  registerWsRoute(
    server,
    buildEngine(opts.seen ?? []),
    new Set(),
    () => {},
    opts.auth,
    opts.systemIdentity ?? null,
    undefined,
    opts.sessionCap
  );
  const frames: WsResponseFrame[] = [];
  const closed: Array<number | undefined> = [];
  let onMsg: ((b: Buffer) => void) | undefined;
  const onClose: Array<() => void> = [];
  const conn: WsConnection = {
    id: 'c1',
    send: (f): void => {
      frames.push(JSON.parse(typeof f === 'string' ? f : Buffer.from(f).toString('utf8')));
    },
    onMessage: (cb): void => {
      onMsg = cb;
    },
    onClose: (cb): void => {
      onClose.push(cb);
    },
    close: (code?: number): void => {
      closed.push(code);
    }
  };
  const headers: Record<string, string> =
    opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {};
  await handler?.({ headers, peerIp: '10.0.0.1' } as unknown as SubstrateRequest, conn);
  return {
    frames,
    closed,
    send: (frame) => onMsg?.(Buffer.from(JSON.stringify(frame))),
    disconnect: () => {
      for (const cb of onClose) cb();
    }
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const subscribe = (id: string) => ({
  id,
  op: 'subscribe',
  frame: { 'default/Memo': { params: {}, fields: { id: true } } }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('kernel WS route sessions', () => {
  it('refuses a second session under an id that is still open', async () => {
    const ws = await open();
    ws.send(subscribe('a'));
    await settle();
    ws.send(subscribe('a'));
    await settle();

    const refused = ws.frames.filter((f) => f.kind === 'error' && f.id === 'a');
    expect(refused.map((f) => f.errors?.[0]?.code)).toEqual(['duplicate_id']);
    ws.disconnect();
  });

  it('ends a subscribe whose every key fails at registration, freeing its id and slot', async () => {
    const ws = await open({ sessionCap: createConnectionLimiter(1) });
    const failing = {
      id: 'a',
      op: 'subscribe',
      frame: { 'default/Nope': { params: {}, fields: { id: true } } }
    };
    ws.send(failing);
    await settle();
    expect(ws.frames.find((f) => f.id === 'a')?.kind).toBe('error');

    ws.send(subscribe('b'));
    await settle();
    ws.send({ id: 'b', op: 'cancel' });
    ws.send(failing);
    await settle();
    const codes = ws.frames.map((f) => f.errors?.[0]?.code);
    expect(codes).not.toContain('duplicate_id');
    expect(codes).not.toContain('too_many_sessions');
    ws.disconnect();
  });

  it('runs an auth-off socket as the system actor, as auth-off HTTP does', async () => {
    const seen: Array<Identity | null> = [];
    const actor: Identity = { id: 'local-dev', grants: { '*': ['read', 'mutate'] } };
    const ws = await open({ systemIdentity: actor, seen });
    ws.send({
      id: 's',
      op: 'stream',
      frame: { 'default/echo': { params: {}, fields: { id: true } } }
    });
    await settle();

    expect(seen.map((i) => i?.id)).toEqual(['local-dev']);
  });

  it('ends open sessions and closes once the token expires', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const exp = Math.floor(Date.now() / 1000) + 20;
    const token = signHs256({ sub: 'u', capabilities: ['read'], exp }, SECRET, { kid: 'k1' });
    const ws = await open({ auth: AUTH, token });
    ws.send(subscribe('a'));
    await settle();
    expect(ws.closed).toEqual([]);

    vi.advanceTimersByTime(30_000 + CREDENTIAL_RECHECK_MS);

    expect(ws.frames.find((f) => f.kind === 'end' && f.id === 'a')?.reason).toBe(
      'credential_expired'
    );
    expect(ws.closed).toEqual([4001]);
  });
});
