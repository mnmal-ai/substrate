/**
 * GET /substrate/v1/onboard — skeleton route coverage. Verifies the onboarding
 * endpoint returns the expected JSON shape (§5.14), and that it needs a key
 * once an `AuthConfig` is present.
 */

import { type ComposeResult, compose, signHs256 } from '@mnmal-ai/substrate-compose';
import { HttpBridgeClient, MemoryBridgeRegistry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  FilterOperatorDef,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

/**
 * A read token for the auth-configured harnesses below (secret 'test-secret').
 * Harmless when auth is off — the header is ignored — so every onboard fetch
 * in this file sends it.
 */
function readAuth(): Record<string, string> {
  const token = signHs256(
    {
      sub: 'onboard-test',
      exp: Math.floor(Date.now() / 1000) + 60,
      capabilities: ['read'],
      ns: ['*']
    },
    'test-secret'
  );
  return { authorization: `Bearer ${token}` };
}

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

describe('GET /substrate/v1/onboard', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  it('returns { substrate: agent-onboard, version } as JSON with status 200', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.2.3'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('application/json');
    const body = JSON.parse(bodyToString(res));
    expect(body.substrate).toBe('agent-onboard');
    expect(body.version).toBe('1.2.3');
  });

  it('defaults version to 0.0.0 when compose is called without version', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(bodyToString(res));
    expect(body.substrate).toBe('agent-onboard');
    expect(body.version).toBe('0.0.0');
  });

  it('needs a key when auth is configured, and answers one holding read', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      auth: { keys: [{ alg: 'HS256', publicKey: 'test-secret' }] },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    const anon = await server.inject({ method: 'GET', path: '/substrate/v1/onboard' });
    expect(anon.status).toBe(401);
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(bodyToString(res));
    expect(body.substrate).toBe('agent-onboard');
  });
});

describe('GET /substrate/v1/onboard — binary metadata', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  it('reports loaded coordinators with their declared namespaces', async () => {
    const testPlugin: CoordinatorPlugin = {
      name: 'test-plugin',
      contractVersion: '*',
      namespaces: [
        { namespace: 'alpha', install: (): void => {} },
        { namespace: 'beta', install: (): void => {} }
      ]
    };
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const alphaDataset = new MemoryDataset({ namespace: 'alpha' });
    const betaDataset = new MemoryDataset({ namespace: 'beta' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      coordinators: [testPlugin],
      datasets: { alpha: alphaDataset, beta: betaDataset }
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.binary.coordinators).toEqual([
      { name: 'test-plugin', namespaces: ['alpha', 'beta'] }
    ]);
  });

  it('reports registered bridges as { ns, name }, without their address', async () => {
    const remoteServer = new MemorySubstrateServer();
    const remoteDataset = new MemoryDataset({ namespace: 'default' });
    const remoteComposed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server: remoteServer,
      dataset: remoteDataset
    });
    await remoteServer.start();

    const bridgeClient = new HttpBridgeClient({
      name: 'remote-bridge',
      baseUrl: 'http://remote.internal',
      fetch: async () => new Response(null, { status: 503 }),
      healthCheckIntervalMs: 60_000
    });
    const bridgesRegistry = new MemoryBridgeRegistry();
    bridgesRegistry.register('default', bridgeClient);

    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'local' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      bridges: bridgesRegistry
    });

    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.binary.bridges).toEqual([{ ns: 'default', name: 'remote-bridge' }]);

    bridgeClient.dispose();
    await remoteComposed.stop();
  });

  it('reports authEnabled=false when auth is absent', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.binary.authEnabled).toBe(false);
  });

  it('reports authEnabled=true when auth is configured', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      auth: { keys: [{ alg: 'HS256', publicKey: 'test-secret' }] },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.binary.authEnabled).toBe(true);
  });
});

describe('GET /substrate/v1/onboard — binary.filterOperators', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
    clearExtensionOperators();
  });

  it('is an empty array when no kernel plugin contributes a filter operator', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.binary.filterOperators).toEqual([]);
  });

  it('exposes sorted operator names when registered', async () => {
    // Register operators in non-sorted order to exercise the sort guarantee.
    const noopOp: FilterOperatorDef = {
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ hits: [] })
    };
    registerExtensionOperator('zebraOp', noopOp);
    registerExtensionOperator('embeddingSimilar', noopOp);
    registerExtensionOperator('alpha', noopOp);

    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.binary.filterOperators).toEqual(['alpha', 'embeddingSimilar', 'zebraOp']);
  });
});

describe('GET /substrate/v1/onboard — frame grammar', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  it('teaches qualified-key grammar and batched-mutate array shape', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.frameGrammar.queryKey).toBe('<ns>/<TypeName>');
    expect(body.frameGrammar.mutationKey).toBe('<ns>/<mutationName>');
    expect(typeof body.frameGrammar.batched).toBe('string');
    expect(body.frameGrammar.batched).toContain('Array<FrameEntry>');
    expect(typeof body.frameGrammar.example).toBe('string');
    // No coordinators loaded → falls back to the `default` namespace.
    expect(body.frameGrammar.example).toContain('default/Todo');
  });

  it('builds the example from the first loaded namespace, not a hardcoded default', async () => {
    const testPlugin: CoordinatorPlugin = {
      name: 'test-plugin',
      contractVersion: '*',
      namespaces: [{ namespace: 'alpha', install: (): void => {} }]
    };
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      coordinators: [testPlugin],
      datasets: { alpha: new MemoryDataset({ namespace: 'alpha' }) }
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.frameGrammar.example).toContain('alpha/Todo');
    expect(body.frameGrammar.example).not.toContain('default/Todo');
  });
});

describe('GET /substrate/v1/onboard — instructions (HTTP core)', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  it('describes query, mutate, schema, and federatedSchema routes', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));

    expect(body.instructions.query).toMatchObject({
      method: 'POST',
      path: '/substrate/v1/query'
    });
    expect(Array.isArray(body.instructions.query.notes)).toBe(true);

    expect(body.instructions.mutate).toMatchObject({
      method: 'POST',
      path: '/substrate/v1/mutate'
    });
    expect(body.instructions.mutate.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('idempotencyKey')])
    );

    expect(body.instructions.schema).toMatchObject({
      method: 'GET',
      path: '/substrate/v1/schema'
    });
    expect(body.instructions.federatedSchema).toMatchObject({
      method: 'GET',
      path: '/substrate/v1/federated-schema'
    });
  });

  // A consumer behind a row mapper never sees `_diagnostics` unless its client
  // exposes the slot, so the obligation has to reach it through the onboard
  // surface — that is the only instruction a non-MCP agent gets.
  it('tells row-mapping consumers to surface _diagnostics, not just retain it', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));

    const notes: string[] = body.instructions.query.notes;
    const mapperNote = notes.find((note) => note.includes('MAP ROWS INTO TYPED OBJECTS'));

    expect(mapperNote).toBeDefined();
    expect(mapperNote).toContain('_diagnostics');
    expect(mapperNote).toContain('SURFACE');
    // The mechanism, not just the instruction: a mapper turns the error into a
    // well-typed null rather than merely losing it.
    expect(mapperNote).toContain('MANUFACTURES A PLAUSIBLE VALUE');
  });
});

describe('GET /substrate/v1/onboard — instructions (WS)', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  /**
   * Checks transport/path routing only. Whether a served frame is actually
   * accepted needs a real route, so frame-grammar assertions live in
   * `substrate-compose/test/onboard-wire-shapes.test.ts`; do not add string
   * matches on frame shapes here.
   */
  it('routes subscribe and stream to the WS transport', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));

    expect(body.instructions.subscribe.transport).toBe('ws');
    expect(body.instructions.subscribe.path).toBe('/substrate/v1/ws');

    expect(body.instructions.stream.transport).toBe('ws');
    expect(body.instructions.stream.path).toBe('/substrate/v1/ws');
  });

  it('names the SSE transport alongside the WS one', async () => {
    // Without the SSE paths, a consumer would conclude the transport does not exist.
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));

    expect(body.instructions.sse.transport).toBe('sse');
    expect(body.instructions.sse.paths).toEqual(
      expect.arrayContaining([
        '/substrate/v1/subscribe',
        '/substrate/v1/stream',
        '/substrate/v1/stream/ticket'
      ])
    );
    expect(body.instructions.substratePack.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('Sec-WebSocket-Protocol')])
    );
  });
});

describe('GET /substrate/v1/onboard — auth instructions (conditional)', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  it('omits instructions.auth when authEnabled=false', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.instructions.auth).toBeUndefined();
  });

  it('emits register + invites routes when authEnabled=true', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      auth: { keys: [{ alg: 'HS256', publicKey: 'test-secret' }] },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.instructions.auth).toBeDefined();
    expect(body.instructions.auth.register).toMatchObject({
      method: 'POST',
      path: '/substrate/v1/_system/register'
    });
    expect(body.instructions.auth.invites).toMatchObject({
      method: 'POST',
      path: '/substrate/v1/_system/invites'
    });
    expect(body.instructions.auth.header).toBe('Authorization: Bearer <jwt>');
  });

  it('describes attribute mode and agent identity', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      auth: { keys: [{ alg: 'HS256', publicKey: 'test-secret' }] },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));

    // Both auth modes must be documented.
    expect(body.instructions.auth.modes.required).toEqual(expect.any(String));
    expect(body.instructions.auth.modes.attribute).toContain('identify-if-present');

    // Agent identity: attribution semantics + the operator runbook pointer.
    expect(body.instructions.auth.identity.attribution).toContain('kind:"agent"');
    expect(body.instructions.auth.identity.mcp).toContain('SUBSTRATE_AGENT_KEY_PATH');
    expect(body.instructions.auth.identity.operatorRunbook).toContain(
      'SUBSTRATE_AUTH_MODE=attribute'
    );
  });
});

describe('GET /substrate/v1/onboard — per-plugin contribution', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  const pluginWithContribution: CoordinatorPlugin = {
    name: 'substrate-example',
    contractVersion: '*',
    namespaces: [{ namespace: 'example', install: (): void => {} }],
    onboardInstructions: {
      summary: 'Example plugin teaching agents how to use its surface',
      types: ['Widget', 'Gadget'],
      writeFlow: 'createWidget → relateWidget'
    }
  };

  const pluginWithoutContribution: CoordinatorPlugin = {
    name: 'substrate-silent',
    contractVersion: '*',
    namespaces: [{ namespace: 'silent', install: (): void => {} }]
  };

  it('aggregates onboardInstructions under instructions.plugins.<name>', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      coordinators: [pluginWithContribution, pluginWithoutContribution],
      datasets: {
        example: new MemoryDataset({ namespace: 'example' }),
        silent: new MemoryDataset({ namespace: 'silent' })
      }
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.instructions.plugins).toEqual({
      'substrate-example': {
        summary: 'Example plugin teaching agents how to use its surface',
        types: ['Widget', 'Gadget'],
        writeFlow: 'createWidget → relateWidget'
      }
    });
  });

  it('lists plugins with contributions under instructions.pluginRoutes with conventional path', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '1.0.0',
      coordinators: [pluginWithContribution, pluginWithoutContribution],
      datasets: {
        example: new MemoryDataset({ namespace: 'example' }),
        silent: new MemoryDataset({ namespace: 'silent' })
      }
    });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/onboard',
      headers: readAuth()
    });
    const body = JSON.parse(bodyToString(res));
    expect(body.instructions.pluginRoutes).toEqual([
      { name: 'substrate-example', onboardPath: '/substrate/v1/plugins/substrate-example/onboard' }
    ]);
  });
});

describe('GET /substrate/v1/onboard — Fastify integration', () => {
  it('serves the same body over a real HTTP listener', async () => {
    const fastifyServer = new FastifySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server: fastifyServer,
      dataset,
      version: '9.9.9'
    });
    const { port } = await fastifyServer.start({ host: '127.0.0.1', port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/substrate/v1/onboard`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.substrate).toBe('agent-onboard');
      expect(body.version).toBe('9.9.9');
      expect(body.binary).toBeDefined();
      expect(body.instructions).toBeDefined();
    } finally {
      await composed.stop();
    }
  });
});
