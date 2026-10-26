/**
 * Integration coverage for `POST /substrate/v1/nl`.
 *
 * NL is a substrate plugin, so this composes the engine and then mounts the
 * plugin's kernel-route claim through `mountKernelRoute` — the same function
 * main.ts uses. Deliberate: the claim carries `capability: 'read'`, and a test
 * that mounted the handler itself would pass whether or not the binary
 * honours the claim.
 *
 * No judge is configured, so the parser alone answers. Rows come from an
 * ephemeral memory dataset seeded via `default/createTodo`. Header keys are
 * injected lower-case because the memory server does not lower-case them.
 */

import {
  type AuthConfig,
  buildContext,
  type ComposeResult,
  compose,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { createNlPlugin } from '@mnmal-ai/substrate-nl';
import { row } from '@mnmal-ai/substrate-policy';
import { installAutoCrud } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { mountKernelRoute } from '../src/_kernel.js';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

interface NlRouteCtx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
}

async function mkServer(opts: {
  registerNl?: boolean;
  auth?: AuthConfig;
  extra?: CoordinatorPlugin[];
}): Promise<NlRouteCtx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const composeOpts: Parameters<typeof compose>[0] = {
    // Without auth, the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset,
    coordinators: [fixturePlugin, ...(opts.extra ?? [])]
  };
  if (opts.auth !== undefined) {
    composeOpts.auth = opts.auth;
    // compose() refuses an auth-enabled instance without a stream-ticket secret.
    composeOpts.streamTicketSecret = 'test-stream-ticket-secret';
  }
  const composed = await compose(composeOpts);

  // Substrate composition happens after the engine exists in the binary too —
  // the plugin's engine access is late-bound for exactly this reason.
  if (opts.registerNl !== false) {
    const plugin = createNlPlugin({
      engine: {
        federatedSchema: () => composed.engine.federatedSchema(),
        operators: () => undefined,
        query: async (frame, req) =>
          composed.engine.query({
            frame,
            ctx: buildContext(req, new Set<string>()),
            ...(req.signal !== undefined ? { signal: req.signal } : {})
          })
      }
    });
    for (const claim of plugin.kernelRoutes ?? []) {
      mountKernelRoute(server, claim, opts.auth ?? null);
    }
  }

  await server.start();
  return { server, composed };
}

async function streamToString(res: SubstrateResponse): Promise<string> {
  if (!(res.body instanceof ReadableStream)) return bodyToString(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return out;
    out += decoder.decode(chunk.value, { stream: true });
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function ask(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST' as const,
    path: '/substrate/v1/nl',
    headers: { ...JSON_HEADERS, ...headers },
    body: Buffer.from(JSON.stringify(body))
  };
}

async function seedTodo(server: MemorySubstrateServer): Promise<void> {
  await server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: JSON_HEADERS,
    body: Buffer.from(
      JSON.stringify({
        'default/createTodo': {
          params: { title: 'nl-seed', status: 'open' },
          fields: { id: true }
        }
      })
    )
  });
}

describe('the NL routes', () => {
  let ctx: NlRouteCtx | null = null;

  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('POST /substrate/v1/nl answers a question as JSON with a rows outcome', async () => {
    ctx = await mkServer({});
    await seedTodo(ctx.server);
    // `status` is unindexed in the fixture and the NL pack only learns indexed fields, so ask for plain todos.
    const res = await ctx.server.inject(ask({ namespace: 'default', question: 'todos' }));
    expect(res.status).toBe(200);
    const parsed = jsonBody<{
      outcome: { kind: string; data?: Record<string, Array<{ title?: string }>> };
    }>(res);
    expect(parsed.outcome.kind).toBe('rows');
    expect(JSON.stringify(parsed.outcome)).toContain('nl-seed');
  });

  it('streams parsed, rows and done as SSE when asked for text/event-stream', async () => {
    ctx = await mkServer({});
    await seedTodo(ctx.server);
    const res = await ctx.server.inject(
      ask({ namespace: 'default', question: 'open todos' }, { accept: 'text/event-stream' })
    );
    expect(res.status).toBe(200);
    const text = await streamToString(res);
    const names = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(['parsed', 'rows', 'done']);
  });

  it('GET /substrate/v1/nl/pack/:ns serves the pack, then 304 on a matching etag', async () => {
    ctx = await mkServer({});
    const first = await ctx.server.inject({ method: 'GET', path: '/substrate/v1/nl/pack/default' });
    expect(first.status).toBe(200);
    const etag = first.headers?.etag;
    expect(typeof etag).toBe('string');
    const second = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/nl/pack/default',
      headers: { 'if-none-match': etag as string }
    });
    expect(second.status).toBe(304);
  });

  it('returns 404 when the NL plugin is not installed', async () => {
    ctx = await mkServer({ registerNl: false });
    const res = await ctx.server.inject(ask({ namespace: 'default', question: 'open todos' }));
    expect(res.status).toBe(404);
  });

  it('is gated by the `read` capability on both routes when auth is enabled', async () => {
    const secret = 'nl-route-secret';
    const kid = 'k-nl';
    const auth: AuthConfig = { keys: [{ kid, alg: 'HS256', publicKey: secret }] };
    ctx = await mkServer({ auth });

    const askAnon = await ctx.server.inject(ask({ namespace: 'default', question: 'open todos' }));
    expect(askAnon.status).toBe(401);
    const packAnon = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/nl/pack/default'
    });
    expect(packAnon.status).toBe(401);

    const noReadCap = signHs256(
      { sub: 'tester', exp: Math.floor(Date.now() / 1000) + 60, capabilities: [] },
      secret,
      { kid }
    );
    const forbidden = await ctx.server.inject(
      ask(
        { namespace: 'default', question: 'open todos' },
        { authorization: `Bearer ${noReadCap}` }
      )
    );
    expect(forbidden.status).toBe(403);

    const withRead = signHs256(
      { sub: 'tester', exp: Math.floor(Date.now() / 1000) + 60, capabilities: ['read'] },
      secret,
      { kid }
    );
    const ok = await ctx.server.inject(
      ask({ namespace: 'default', question: 'open todos' }, { authorization: `Bearer ${withRead}` })
    );
    expect(ok.status).toBe(200);
  });
});

/** A namespace whose read policy hides `project: 'secret'` rows from the identity `restricted`. */
const vaultPlugin: CoordinatorPlugin = {
  name: 'vault',
  contractVersion: '*',
  namespaces: [
    {
      namespace: 'vault',
      install: async ({ registry, dataset, edges }) => {
        installAutoCrud(registry, 'Doc', dataset, edges, {
          fields: {
            id: { kind: 'scalar', type: 'string', indexed: true },
            title: { kind: 'scalar', type: 'string', indexed: true },
            project: { kind: 'scalar', type: 'string', indexed: true }
          },
          policy: row<{ project?: string }>(
            (ctx, r) => !(ctx.identity?.id === 'restricted' && r.project === 'secret')
          )
        });
      }
    }
  ]
};

describe('GET /substrate/v1/nl/pack/:ns under row policy', () => {
  let ctx: NlRouteCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('a pack never carries a value the caller cannot read, and the etags differ', async () => {
    const secret = 'nl-pack-secret';
    const kid = 'k-pack';
    ctx = await mkServer({
      auth: { keys: [{ kid, alg: 'HS256', publicKey: secret }] },
      extra: [vaultPlugin]
    });
    const token = (sub: string) =>
      `Bearer ${signHs256(
        { sub, exp: Math.floor(Date.now() / 1000) + 60, capabilities: ['read', 'mutate'] },
        secret,
        { kid }
      )}`;
    for (const [title, project] of [
      ['shared doc', 'public'],
      ['hidden doc', 'secret']
    ] as const) {
      const res = await ctx.server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { ...JSON_HEADERS, authorization: token('full') },
        body: Buffer.from(
          JSON.stringify({
            'vault/createDoc': { params: { title, project }, fields: { id: true } }
          })
        )
      });
      expect(res.status).toBe(200);
    }
    const pack = async (sub: string) => {
      const res = await ctx?.server.inject({
        method: 'GET',
        path: '/substrate/v1/nl/pack/vault',
        headers: { authorization: token(sub) }
      });
      expect(res?.status).toBe(200);
      return { etag: res?.headers?.etag, body: bodyToString(res as SubstrateResponse) };
    };
    const full = await pack('full');
    const restricted = await pack('restricted');
    expect(full.body).toContain('secret');
    expect(restricted.body).toContain('public');
    expect(restricted.body).not.toContain('secret');
    expect(restricted.body).not.toContain('hidden doc');
    expect(full.etag).not.toBe(restricted.etag);
  });
});
