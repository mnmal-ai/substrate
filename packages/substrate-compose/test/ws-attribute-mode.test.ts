/**
 * The kernel `/substrate/v1/ws` route honours `AuthConfig.mode` the way
 * `POST /substrate/v1/query`, `POST /substrate/v1/mutate` and SSE `POST /substrate/v1/subscribe`
 * do: all admit an anonymous caller under `attribute`. The plugin-WS path
 * (`wrapWsHandler`) mirrors `withAuth` the same way and is covered by
 * `plugin-ws-auth.test.ts`.
 *
 * The four cases below are the whole matrix — {attribute, required} × {absent,
 * invalid} — because only ONE cell differs between modes. A present-but-invalid
 * token is refused in both, and that is the cell a careless "just honour the
 * mode" fix would open.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../src/auth.js';
import { signHs256 } from '../src/auth.js';
import { registerWsRoute } from '../src/routes/ws.js';

const HS_SECRET = 'ws-attribute-mode-test-secret';
const HS_KID = 'ws-attr';

const ATTRIBUTE_AUTH: AuthConfig = {
  mode: 'attribute',
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }]
};
const REQUIRED_AUTH: AuthConfig = {
  mode: 'required',
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }]
};

function validToken(): string {
  return signHs256(
    { sub: 'ws-caller', capabilities: ['read'], exp: Math.floor(Date.now() / 1000) + 300 },
    HS_SECRET,
    { kid: HS_KID }
  );
}

function buildEngine(): Engine {
  const registry = new Registry();
  registry.register('Memo', { resolver: async () => [{ id: 'm1' }] });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  return new Engine({
    namespaces: new Map([['default', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-08-25T00:00:00Z') })
  });
}

interface Harness {
  sent: string[];
  closed: Array<number | undefined>;
}

/** Open a socket against the real route and report what it did. */
async function connect(auth: AuthConfig, headers: Record<string, string>): Promise<Harness> {
  let handler: WsHandler | undefined;
  const server = {
    route: () => {},
    websocket: (_path: string, h: WsHandler) => {
      handler = h;
    }
  } as unknown as SubstrateServer;

  registerWsRoute(server, buildEngine(), new Set<string>(), () => {}, auth);

  const sent: string[] = [];
  const closed: Array<number | undefined> = [];
  const conn: WsConnection = {
    id: 'c1',
    send: (d: string | Buffer) => {
      sent.push(String(d));
    },
    onMessage: () => {},
    onClose: () => {},
    close: (code?: number) => {
      closed.push(code);
    }
  } as unknown as WsConnection;

  const req = {
    method: 'GET',
    path: '/substrate/v1/ws',
    headers,
    query: {},
    params: {},
    body: null
  } as unknown as SubstrateRequest;

  await handler?.(req, conn);
  return { sent, closed };
}

describe('kernel /substrate/v1/ws honours AuthConfig.mode', () => {
  it('attribute + absent token: connects anonymously', async () => {
    const { sent, closed } = await connect(ATTRIBUTE_AUTH, {});

    // The one cell that differs. Anonymous is what HTTP and SSE also allow.
    expect(closed).toEqual([]);
    expect(sent.join('')).not.toContain('unauthorized');
  });

  it('attribute + INVALID token: still closes 4001', async () => {
    // The cell a careless fix opens. `withAuth` refuses a present-but-invalid
    // token in BOTH modes — "identify if present" is not "trust if present".
    const { closed, sent } = await connect(ATTRIBUTE_AUTH, {
      authorization: 'Bearer not-a-real-token'
    });

    expect(closed).toEqual([4001]);
    expect(sent.join('')).toContain('unauthorized');
  });

  it('required + absent token: closes 4001', async () => {
    // Unchanged, and the reason the mode is consulted rather than dropped.
    const { closed } = await connect(REQUIRED_AUTH, {});
    expect(closed).toEqual([4001]);
  });

  it('required + valid token: connects', async () => {
    const { closed } = await connect(REQUIRED_AUTH, { authorization: `Bearer ${validToken()}` });
    expect(closed).toEqual([]);
  });

  it('attribute + valid token: connects', async () => {
    const { closed } = await connect(ATTRIBUTE_AUTH, { authorization: `Bearer ${validToken()}` });
    expect(closed).toEqual([]);
  });
});
