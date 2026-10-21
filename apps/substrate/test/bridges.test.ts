/**
 * §5.8 + §6.5 integration — two in-process Substrate instances connected via an
 * `HttpBridgeClient` whose fetch is shimmed to route requests directly into
 * the remote's `MemorySubstrateServer.inject`. Covers:
 *
 * §5.8:
 *   - Federated schema includes bridged types under the bridge alias.
 *   - A multi-key query frame spanning local + bridge returns both.
 *   - A mutate through the bridge commits to the remote and round-trips on
 *     read-back.
 *
 * §6.5:
 *   - Unreachable bridge on query surfaces `{ __orphan: true, reason:
 *     'bridge_unreachable' }` per-key; local keys still succeed (reads never
 *     fail).
 *   - Unreachable bridge on mutate surfaces a per-key `bridge_unreachable`
 *     error; local keys commit (bridge mutate is NOT atomic with local).
 *   - Sweep + cascade blocked: a local Tag edge to a bridged Todo; delete the
 *     bridged Todo; run sweep while bridge is unreachable; edge becomes
 *     `blocked: true` and `cascade_blocked_bridge` metric fires; findBlocked
 *     returns the edge.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { HttpBridgeClient, MemoryBridgeRegistry, runSweep } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { installAutoCrud } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope, Schema } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

type FetchShim = typeof fetch;

function injectAsFetch(server: MemorySubstrateServer): FetchShim {
  const shim: FetchShim = async (input, init) => {
    const urlStr =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase() as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE'
      | 'PATCH'
      | 'HEAD'
      | 'OPTIONS';

    const rawHeaders = init?.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders !== undefined) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    let body: Buffer | null = null;
    const rawBody = init?.body;
    if (typeof rawBody === 'string') body = Buffer.from(rawBody);
    else if (rawBody instanceof Uint8Array) body = Buffer.from(rawBody);

    const res = await server.inject({
      method,
      path: u.pathname + u.search,
      headers,
      body
    });

    const resHeaders = new Headers();
    if (res.headers !== undefined) {
      for (const [k, v] of Object.entries(res.headers)) resHeaders.set(k, v);
    }
    const resBody = res.body;
    let payload: string | Uint8Array | null = null;
    if (resBody === undefined || resBody === null) payload = null;
    else if (typeof resBody === 'string') payload = resBody;
    else if (Buffer.isBuffer(resBody)) payload = new Uint8Array(resBody);
    else if (resBody instanceof Uint8Array) payload = resBody;
    return new Response(payload, { status: res.status, headers: resHeaders });
  };
  return shim;
}

/**
 * Route fetches for `baseUrl` through `realShim`, but fail all others with a
 * connection error. Used to simulate an unreachable bridge: the caller flips
 * the guarded flag and subsequent calls reject.
 */
interface ToggleFetch {
  fetch: FetchShim;
  reachable: boolean;
}

function mkToggleFetch(realShim: FetchShim): ToggleFetch {
  const obj: ToggleFetch = {
    reachable: true,
    fetch: async (input, init) => {
      if (!obj.reachable) throw new Error('connect ECONNREFUSED');
      return realShim(input, init);
    }
  };
  return obj;
}

describe('apps/substrate — §5.8 / §6.5 bridge integration', () => {
  let local: { server: MemorySubstrateServer; dataset: MemoryDataset; composed: ComposeResult };
  let remote: { server: MemorySubstrateServer; dataset: MemoryDataset; composed: ComposeResult };
  let bridges: MemoryBridgeRegistry;
  let bridgeClient: HttpBridgeClient;
  let toggle: ToggleFetch;

  beforeEach(async () => {
    // Remote instance — runs with the default demo types (Todo, Tag).
    const remoteServer = new MemorySubstrateServer();
    const remoteDataset = new MemoryDataset({ namespace: 'default' });
    const remoteComposed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server: remoteServer,
      dataset: remoteDataset,
      coordinators: [fixturePlugin]
    });
    await remoteServer.start();
    remote = { server: remoteServer, dataset: remoteDataset, composed: remoteComposed };

    // Fetch shim routed at the remote's inject surface, wrapped in a
    // reachability toggle so tests can simulate network outage.
    toggle = mkToggleFetch(injectAsFetch(remoteServer));

    // Bridge alias: `default` (on the local side) maps to the remote's
    // `default` namespace. Local compose sees frame keys like
    // `default/Todo` and must route them to the bridge because local
    // `default` is absent.
    bridgeClient = new HttpBridgeClient({
      name: 'remote',
      baseUrl: 'http://remote.internal',
      fetch: toggle.fetch,
      healthCheckIntervalMs: 60_000
    });
    bridges = new MemoryBridgeRegistry();
    bridges.register('default', bridgeClient);

    // Local instance — NO local `default` dataset (so `default/*` keys route
    // to the bridge). We give it a different namespace for local types.
    const localServer = new MemorySubstrateServer();
    const localDataset = new MemoryDataset({ namespace: 'local' });
    const localComposed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server: localServer,
      dataset: localDataset,
      coordinators: [
        {
          name: 'tag',
          contractVersion: '*',
          namespaces: [
            {
              namespace: 'local',
              install(ctx): void {
                installAutoCrud(ctx.registry, 'Tag', ctx.dataset, ctx.edges, {
                  fields: {
                    id: { kind: 'scalar', type: 'string', indexed: true },
                    label: { kind: 'scalar', type: 'string', indexed: true },
                    todoId: {
                      kind: 'crossRef',
                      ns: 'default',
                      type: 'Todo',
                      onDelete: 'cascade'
                    }
                  }
                });
              }
            }
          ]
        }
      ],
      datasets: { local: localDataset },
      bridges
    });
    await localServer.start();
    local = { server: localServer, dataset: localDataset, composed: localComposed };
  });

  afterEach(async () => {
    bridgeClient.dispose();
    await local.composed.stop();
    await remote.composed.stop();
  });

  it('§5.8 federatedSchema includes bridged types under the bridge alias', async () => {
    const federated = local.composed.engine.federatedSchema();
    expect(federated.local).toBeDefined();
    expect(federated.default).toBeDefined();
    // The bridged `default` schema came from the remote's compose and
    // includes Todo + Tag.
    expect(federated.default?.types.Todo).toBeDefined();
  });

  it('§5.8 query frame spanning local + bridge returns both in one envelope', async () => {
    // Seed one Todo on the remote.
    const createRes = await remote.server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { id: 't-1', title: 'buy wine', done: false },
            fields: { id: true, title: true }
          }
        })
      )
    });
    expect(createRes.status).toBe(200);

    // Seed one local Tag pointing at the bridged Todo. Use the local
    // dataset directly — cross-substrate refusal would block an engine
    // mutate that touches both.
    await local.dataset.write('Tag', [{ id: 'tag-1', label: 'dinner', todoId: 't-1' }]);

    // Mixed query: one local, one bridge.
    const envelope = await local.composed.engine.query({
      frame: {
        'local/Tag': { params: { limit: 10 }, fields: { id: true, label: true, todoId: true } },
        'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true } }
      },
      ctx: { identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } } }
    });

    expect(envelope.errors).toBeUndefined();
    expect(envelope.data['local/Tag']).toBeDefined();
    expect(Array.isArray(envelope.data['local/Tag'])).toBe(true);
    expect(envelope.data['default/Todo']).toBeDefined();
  });

  it('§5.8 mutate through the bridge commits to the remote', async () => {
    const envelope = await local.composed.engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't-bridge', title: 'book table', done: false },
          fields: { id: true, title: true }
        }
      },
      ctx: { identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } } }
    });
    expect(envelope.errors).toBeUndefined();
    expect(envelope.data['default/createTodo']).toBeDefined();

    // Read back directly from the remote's dataset.
    const { rows } = await remote.dataset.read('Todo', { id: 't-bridge' });
    expect(rows[0]?.title).toBe('book table');
  });

  it('§6.5 query with unreachable bridge surfaces __orphan per-key; local keys still succeed', async () => {
    await local.dataset.write('Tag', [{ id: 'tag-1', label: 'dinner', todoId: 't-1' }]);

    toggle.reachable = false;
    // Force the client's cached verdict to false via a failing call. The
    // health-probe interval is long so we flip it manually.
    await expect(bridgeClient.federatedSchema()).rejects.toThrow();
    expect(bridgeClient.isReachable()).toBe(false);

    const envelope = await local.composed.engine.query({
      frame: {
        'local/Tag': { params: { limit: 10 }, fields: { id: true, label: true } },
        'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true } }
      },
      ctx: { identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } } }
    });

    // Local key succeeded.
    expect(envelope.data['local/Tag']).toBeDefined();
    expect(Array.isArray(envelope.data['local/Tag'])).toBe(true);

    // Bridged key orphan-flagged.
    const bridged = envelope.data['default/Todo'] as { __orphan: boolean; reason: string };
    expect(bridged).toEqual({ __orphan: true, reason: 'bridge_unreachable' });
    expect(envelope.errors).toBeUndefined();
  });

  it('§6.5 mutate with unreachable bridge returns per-key error; local commits', async () => {
    toggle.reachable = false;
    await expect(bridgeClient.federatedSchema()).rejects.toThrow();
    expect(bridgeClient.isReachable()).toBe(false);

    const envelope = await local.composed.engine.mutate({
      frame: {
        'local/createTag': {
          params: { id: 'tag-new', label: 'wine', todoId: 't-1' },
          fields: { id: true, label: true }
        },
        'default/createTodo': {
          params: { id: 't-new', title: 'should fail', done: false },
          fields: { id: true }
        }
      },
      ctx: { identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } } }
    });

    // Local key committed.
    const { rows } = await local.dataset.read('Tag', { id: 'tag-new' });
    expect(rows[0]?.label).toBe('wine');

    // Bridged key errored.
    expect(envelope.errors).toBeDefined();
    const bridgeErr = envelope.errors?.find((e) => e.code === 'bridge_unreachable');
    expect(bridgeErr).toBeDefined();
    expect(bridgeErr?.path).toEqual(['default/createTodo']);

    // Remote did NOT commit the bridged key.
    const { rows: remoteRows } = await remote.dataset.read('Todo', { id: 't-new' });
    expect(remoteRows).toHaveLength(0);
  });

  it('§6.5 sweep: cascade blocked when bridge unreachable; findBlocked returns the edge', async () => {
    // 1. Seed a Todo on the remote.
    await remote.dataset.write('Todo', [{ id: 't-99', title: 'doomed', done: false }]);

    // 2. Seed a local Tag referencing that Todo and write the cross-ns edge.
    await local.dataset.write('Tag', [{ id: 'tag-99', label: 'doomed-tag', todoId: 't-99' }]);
    await local.composed.edges.write({
      from: { ns: 'local', type: 'Tag', id: 'tag-99' },
      to: { ns: 'default', type: 'Todo', id: 't-99', bridged: true },
      fieldName: 'todoId',
      policy: 'cascade'
    });

    // 3. Tombstone the bridged Todo via the bridge (simulating a cross-ns
    //    delete from the local side). We reach into the remote dataset
    //    directly — engine.mutate through the bridge would also work but
    //    is pipelined through HTTP.
    await remote.dataset.tombstone('Todo', ['t-99']);

    // 4. Flip the bridge to unreachable before the sweep runs.
    toggle.reachable = false;
    await expect(bridgeClient.federatedSchema()).rejects.toThrow();

    // 5. Run sweep. resolveTarget hits the bridge; with reachable=false the
    //    readRow throws BridgeUnreachableError which is caught and mapped
    //    to MISSING. The outer sweep loop then checks
    //    `bridges.isUnreachable(ns)` and bails with `bridge_unreachable`.
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const { datasets, edges } = local.composed;
    await runSweep(
      {
        datasets,
        bridges,
        edges,
        now: (): Date => new Date(),
        metric: (name, payload): void => {
          metrics.push({ name, payload });
        }
      },
      { lastSweptCursor: null }
    );

    // On the MISSING-with-unreachable branch the edge is left untouched —
    // no lastSweptAt, no blocked. The `bridge_unreachable` metric fires.
    expect(metrics.some((m) => m.name === 'bridge_unreachable')).toBe(true);

    // 6. Now simulate the other arc — resolveTarget returns DELETED (we have
    //    a local cache of the remote tombstone). We can't easily trigger
    //    that with our setup because resolveTarget uses the bridge for
    //    bridged namespaces. Instead, we inject a fake `BridgeClient` that
    //    returns a tombstoned row but still reports itself unreachable for
    //    the policy check — this exercises the `applyPolicy('cascade')`
    //    blocked path explicitly.
    const fakeClient = {
      name: 'fake',
      baseUrl: 'http://fake',
      async federatedSchema(): Promise<Record<string, Schema>> {
        return {};
      },
      async query(): Promise<PackEnvelope> {
        return { schemaVersion: '000000000000', data: {}, shapes: {} };
      },
      async mutate(): Promise<PackEnvelope> {
        return { schemaVersion: '000000000000', data: {}, shapes: {} };
      },
      async readRow(): Promise<{ id: string; _deletedAt: Date } | null> {
        return { id: 't-99', _deletedAt: new Date('2026-04-18T00:00:00Z') };
      },
      isReachable(): boolean {
        return false;
      },
      dispose(): void {}
    };
    // Swap the bridge for the fake client via a wrapper registry.
    const fakeRegistry = new MemoryBridgeRegistry();
    fakeRegistry.register('default', fakeClient);
    const phase2Metrics: Array<{ name: string; payload?: unknown }> = [];
    await runSweep(
      {
        datasets,
        bridges: fakeRegistry,
        edges,
        now: (): Date => new Date(),
        metric: (name, payload): void => {
          phase2Metrics.push({ name, payload });
        }
      },
      { lastSweptCursor: null }
    );

    expect(phase2Metrics.some((m) => m.name === 'cascade_blocked_bridge')).toBe(true);

    const blocked = await local.composed.edges.findBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.fieldName).toBe('todoId');
    expect(blocked[0]?.to.ns).toBe('default');
    expect(blocked[0]?.to.id).toBe('t-99');
  });
});
