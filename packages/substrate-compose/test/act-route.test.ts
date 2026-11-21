/**
 * POST /substrate/v1/act and GET /substrate/v1/act/results/:id over a composed
 * server: signed callers only when auth is on, the system actor when it is off,
 * and a result id another caller holds answers exactly as an unknown one.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { ActHandle, ActInput } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import { actRoute } from '../src/routes/act.js';

interface ActJson {
  ok?: boolean;
  ack?: string;
  result?: string;
  refusal?: { code: string };
  owner?: string;
  code?: string;
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const coordinators = [
  {
    name: 'work',
    contractVersion: '*',
    namespaces: [
      defineNamespace('work', {
        Todo: {
          fields: { title: field.string(), done: field.boolean({ default: false }) },
          actions: { close: { past: 'closed', set: { done: true } } }
        }
      })
    ]
  }
];

function key(kid: string) {
  const secret = `${kid}-secret`;
  const token = () => {
    const now = Math.floor(Date.now() / 1000);
    return signHs256(
      { sub: kid, exp: now + 300, capabilities: ['read', 'mutate'], ns: ['*'] },
      secret,
      { kid }
    );
  };
  return { cfg: { kid, alg: 'HS256' as const, publicKey: secret }, token };
}

async function setup(opts: { auth: boolean }) {
  const alice = key('alice@host');
  const bob = key('bob@host');
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'local-dev',
    server,
    dataset: new MemoryDataset({ namespace: 'work' }),
    coordinators,
    ...(opts.auth ? { auth: { keys: [alice.cfg, bob.cfg], mode: 'attribute' as const } } : {})
  });
  await server.start();
  stop = () => composed.stop();
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: () => string
  ) => {
    const res = await server.inject({
      method,
      path,
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token()}` } : {})
      },
      ...(body !== undefined ? { body: Buffer.from(JSON.stringify(body)) } : {})
    });
    const text = Buffer.from(res.body as Buffer).toString();
    return { status: res.status, text, json: JSON.parse(text) as ActJson };
  };
  const seed = async (token?: () => string) => {
    const created = await call(
      'POST',
      '/substrate/v1/mutate',
      { 'work/createTodo': { params: { title: 't' } } },
      token
    );
    expect(created.status).toBe(200);
  };
  return { alice, bob, call, seed };
}

describe('act routes with auth on', () => {
  it('runs a sketch and returns the result only to its owner', async () => {
    const { alice, bob, call, seed } = await setup({ auth: true });
    await seed(alice.token);

    const done = await call('POST', '/substrate/v1/act', { sketch: 'close Todo #1' }, alice.token);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ ok: true, ack: 'closed work/Todo #1' });
    const id = done.json.result as string;

    const own = await call('GET', `/substrate/v1/act/results/${id}`, undefined, alice.token);
    expect(own.status).toBe(200);
    expect(own.json.owner).toBe('alice@host');

    const other = await call('GET', `/substrate/v1/act/results/${id}`, undefined, bob.token);
    const unknown = await call('GET', '/substrate/v1/act/results/r_nope', undefined, bob.token);
    expect(other.status).toBe(404);
    expect(other.text).toBe('{"code":"not_found","message":"no such result"}');
    expect(other.text).toBe(unknown.text);
    expect(other.status).toBe(unknown.status);
  });

  it('refuses a tokenless call with 401 unauthorized', async () => {
    const { call } = await setup({ auth: true });
    const post = await call('POST', '/substrate/v1/act', { sketch: 'close Todo #1' });
    expect(post.status).toBe(401);
    expect(post.json.code).toBe('unauthorized');
    const get = await call('GET', '/substrate/v1/act/results/r_x');
    expect(get.status).toBe(401);
  });

  it('answers a refusal sketch with 200 ok:false', async () => {
    const { alice, call } = await setup({ auth: true });
    const res = await call(
      'POST',
      '/substrate/v1/act',
      { sketch: 'frobnicate Todo #1' },
      alice.token
    );
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.refusal?.code).toBe('sketch_unresolved');
  });

  it.each([
    [{ sketch: 5 }],
    [{ sketch: '' }],
    [{ sketch: [1] }],
    [{ sketch: 'x', mode: 'commit' }],
    [{ sketch: 'x', namespace: '' }],
    [{ sketch: 'x', idempotencyKey: '' }],
    [{ sketch: 'x', idempotencyKey: 'k'.repeat(257) }]
  ])('rejects a malformed body %j with 400', async (body) => {
    const { alice, call } = await setup({ auth: true });
    const res = await call('POST', '/substrate/v1/act', body, alice.token);
    expect(res.status).toBe(400);
  });
});

describe('act routes with auth off', () => {
  it('acts as the system actor', async () => {
    const { call, seed } = await setup({ auth: false });
    await seed();
    const done = await call('POST', '/substrate/v1/act', { sketch: 'close Todo #1' });
    expect(done.status).toBe(200);
    expect(done.json.ok).toBe(true);
    const rec = await call('GET', `/substrate/v1/act/results/${done.json.result}`);
    expect(rec.status).toBe(200);
    expect(rec.json.owner).toBe('local-dev');
  });
});

describe('actRoute', () => {
  it('passes the known request fields and the page limits to the engine, nothing else', async () => {
    const seen: ActInput[] = [];
    const engine: ActHandle = {
      act: async (input) => {
        seen.push(input);
        return { ok: true, ack: 'a', result: null };
      },
      actResult: async () => undefined
    };
    const pageLimits = { defaultLimit: 5, maxLimit: 10 };
    const route = actRoute(engine, new Set(), false, pageLimits);
    const body = {
      sketch: 'find Todo',
      mode: 'dry-run',
      namespace: 'work',
      idempotencyKey: 'k',
      ctx: { identity: { id: 'forged' } },
      extra: 1
    };
    const res = await route({
      method: 'POST',
      path: '/substrate/v1/act',
      headers: {},
      query: {},
      params: {},
      body: Buffer.from(JSON.stringify(body))
    });
    expect(res.status).toBe(200);
    const [input] = seen as [ActInput];
    expect(Object.keys(input).sort()).toEqual([
      'ctx',
      'idempotencyKey',
      'mode',
      'namespace',
      'pageLimits',
      'sketch'
    ]);
    expect(input.ctx.identity).toBeNull();
    expect(input.pageLimits).toEqual(pageLimits);
  });
});
