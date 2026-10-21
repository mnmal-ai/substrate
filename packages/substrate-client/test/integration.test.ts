/**
 * Integration tests — SubstrateClient <-> FastifySubstrateServer in-process.
 *
 * These tests stand up a real Fastify server on an ephemeral port and drive it
 * through `SubstrateClient` over HTTP + WS. No MSW mocks; 127.0.0.1 requests are
 * exempted from MSW interception in _setup.ts.
 *
 * The `default` namespace with Todo + Tag types is registered by the
 * `demoPlugin` fixture (./fixtures/demo-plugin.ts).
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/index.js';
import { demoPlugin } from './fixtures/demo-plugin.js';

let baseUrl: string;
let composed: ComposeResult;
let server: FastifySubstrateServer;

beforeEach(async () => {
  server = new FastifySubstrateServer({ logger: false });
  const dataset = new MemoryDataset({ namespace: 'default' });
  composed = await compose({
    // Auth is off in this harness, so the deployment declares who it writes
    // as — `resolveIdentity` does not invent one.
    systemActor: 'test',
    server,
    dataset,
    coordinators: [demoPlugin]
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await composed.stop();
});

describe('SubstrateClient <-> FastifySubstrateServer integration', () => {
  it('queries default/Todo via HTTP+JSON', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl });
    const env = await client.query({
      'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true } }
    });
    expect(env.data['default/Todo']).toBeDefined();
    await client.close();
  });

  it('creates then queries a Todo through HTTP', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl });
    await client.mutate({
      'default/createTodo': { params: { title: 'integration-test' }, fields: { id: true } }
    });
    const env = await client.query({
      'default/Todo': {
        params: { where: { title: { eq: 'integration-test' } } },
        fields: { id: true, title: true }
      }
    });
    expect((env.data['default/Todo'] as unknown[]).length).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it('subscribes to default/Todo over WS and receives snapshot + add on new create', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl });
    const events: string[] = [];
    const iter = client
      .subscribe({ 'default/Todo': { params: {}, fields: { id: true } } })
      [Symbol.asyncIterator]();

    const { value: snapshot } = await iter.next();
    events.push((snapshot as { kind: string }).kind);
    expect(events).toContain('snapshot');

    // Trigger an add via a second client
    const mutator = new SubstrateClient({ endpoint: baseUrl });
    await mutator.mutate({
      'default/createTodo': { params: { title: 'sub-test' }, fields: { id: true } }
    });

    const { value: addEvt } = await iter.next();
    events.push((addEvt as { kind: string }).kind);
    expect(events).toEqual(['snapshot', 'add']);

    await iter.return?.();
    await client.close();
    await mutator.close();
  });

  it('watch yields a typed row-set on snapshot, then a grown set on create', async () => {
    interface TodoRow {
      id: string;
      title?: string;
    }
    const client = new SubstrateClient({ endpoint: baseUrl });
    const iter = client
      .watch<TodoRow>({ 'default/Todo': { params: {}, fields: { title: true } } })
      [Symbol.asyncIterator]();

    // First yield is the maintained set built from the initial snapshot.
    const { value: initial } = await iter.next();
    expect(Array.isArray(initial)).toBe(true);
    const baseline = (initial as TodoRow[]).length;

    const mutator = new SubstrateClient({ endpoint: baseUrl });
    await mutator.mutate({
      'default/createTodo': { params: { title: 'watch-test' }, fields: { id: true } }
    });

    // Next yield reflects the add folded into the row-set — typed rows, no
    // SubscribeEvent envelope in sight. `id` was force-selected by watch.
    const { value: grown } = await iter.next();
    const rows = grown as TodoRow[];
    expect(rows.length).toBe(baseline + 1);
    const added = rows.find((r) => r.title === 'watch-test');
    expect(added).toBeDefined();
    expect(typeof added?.id).toBe('string');

    await iter.return?.();
    await client.close();
    await mutator.close();
  });

  it('federated schema fetched once and cached across queries', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl });
    const schema1 = await client.federatedSchema();
    const schema2 = await client.federatedSchema();
    expect(schema1).toBe(schema2); // reference-equal: cached
    await client.close();
  });

  // Pack-over-WS subscription — verifies subprotocol negotiation, msgpack
  // framing, and the positional → named decode at the SubstrateClient facade.
  it('subscribes via wsEncoding=pack and receives named-object data', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl, wsEncoding: 'pack' });
    const iter = client
      .subscribe({ 'default/Todo': { params: {}, fields: { id: true, title: true } } })
      [Symbol.asyncIterator]();

    const { value: snapshot } = await iter.next();
    expect((snapshot as { kind: string }).kind).toBe('snapshot');

    const mutator = new SubstrateClient({ endpoint: baseUrl });
    await mutator.mutate({
      'default/createTodo': { params: { title: 'pack-sub' }, fields: { id: true } }
    });

    const { value: addEvt } = await iter.next();
    const ev = addEvt as { kind: string; data: Record<string, unknown> };
    expect(ev.kind).toBe('add');
    const row = ev.data['default/Todo'] as { id: string; title: string };
    expect(row.title).toBe('pack-sub');
    expect(typeof row.id).toBe('string');

    await iter.return?.();
    await client.close();
    await mutator.close();
  });

  // Pack-mode decode + return() promptness (see pack-return-hazard.test.ts).
  // Verifies that applyDecodePlanInPlace still runs through the pack wrapper
  // (named-object row, not positional tuple) AND that return() resolves
  // promptly in the Suspended-Await scenario against a real server.
  it('pack-mode decode still applies + return() is prompt', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl, wsEncoding: 'pack' });
    const mutator = new SubstrateClient({ endpoint: baseUrl });
    await mutator.mutate({
      'default/createTodo': { params: { title: 'decode-check' }, fields: { id: true } }
    });

    const iter = client
      .subscribe({ 'default/Todo': { params: {}, fields: { id: true, title: true } } })
      [Symbol.asyncIterator]();

    // Step 1: read snapshot — must contain a named-object row (decode applied).
    const { value: snapshot } = await iter.next();
    const snap = snapshot as { kind: string; data: Record<string, unknown> };
    expect(snap.kind).toBe('snapshot');
    const rows = snap.data['default/Todo'] as Array<{ id: string; title: string }>;
    expect(Array.isArray(rows)).toBe(true);
    const added = rows.find((r) => r.title === 'decode-check');
    expect(added).toBeDefined();
    expect(typeof added?.id).toBe('string'); // named-field, not positional tuple

    // Step 2: put the generator into Suspended-Await (call next() without awaiting).
    void iter.next();
    await new Promise<void>((r) => setTimeout(r, 20));

    // Step 3: return() must win the race — not hang.
    const outcome = await Promise.race([
      iter.return!().then(() => 'returned'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 1000))
    ]);
    expect(outcome).toBe('returned');

    await client.close();
    await mutator.close();
  });

  // Pack-mode round-trip — covers the positional-decode path at the facade.
  it('round-trips a Todo query via wire=pack', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl });
    await client.mutate({
      'default/createTodo': { params: { title: 'pack-test' }, fields: { id: true } }
    });
    const env = await client.query(
      {
        'default/Todo': {
          params: { where: { title: { eq: 'pack-test' } } },
          fields: { id: true, title: true }
        }
      },
      { wire: 'pack' }
    );
    const rows = env.data['default/Todo'] as Array<{ id: number; title: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.title).toBe('pack-test'); // named-field decode, not positional tuple
    await client.close();
  });
});
