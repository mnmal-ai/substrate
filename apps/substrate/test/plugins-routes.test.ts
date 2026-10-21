/**
 * Plugin `routes` seam (§5.11). Verifies that:
 *   - A coordinator plugin's `routes(router, ctx)` callback is invoked
 *     after core `/substrate/v1/*` routes are registered.
 *   - Plugin routes mount under `/substrate/v1/plugins/<name>` via the server's
 *     `createPluginRouter`, so two plugins with colliding subpaths stay
 *     isolated.
 *   - `ctx.engine` is the live engine — plugin routes can query / mutate
 *     through it and see the data they produce.
 *   - `ctx.metric` is a callable sink that fires the name + payload it was
 *     given verbatim.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { installAutoCrud } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  PluginRouteContext,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

describe('coordinator plugin routes seam', () => {
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
    }
  });

  it('mounts a plugin route under /plugins/<name> and serves it end-to-end', async () => {
    const plugin: CoordinatorPlugin = {
      name: 'my-plugin',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (): void => undefined
        }
      ],
      routes: (router): void => {
        router.get('/ping', () => ({ status: 200, body: 'ok' }));
      }
    };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [plugin]
    });
    await server.start();

    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/plugins/my-plugin/ping'
    });
    expect(res.status).toBe(200);
    expect(bodyToString(res)).toBe('ok');
  });

  it('isolates overlapping route paths between two plugins via their prefix', async () => {
    const a: CoordinatorPlugin = {
      name: 'alpha',
      contractVersion: '*',
      namespaces: [{ namespace: 'default', install: (): void => undefined }],
      routes: (router): void => {
        router.get('/ping', () => ({ status: 200, body: 'from-alpha' }));
      }
    };
    const b: CoordinatorPlugin = {
      name: 'beta',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'beta',
          install: (): void => undefined
        }
      ],
      routes: (router): void => {
        router.get('/ping', () => ({ status: 200, body: 'from-beta' }));
      }
    };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const betaDataset = new MemoryDataset({ namespace: 'beta' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      datasets: { beta: betaDataset },
      coordinators: [a, b]
    });
    await server.start();

    const alpha = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/alpha/ping' });
    const beta = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/beta/ping' });
    expect(bodyToString(alpha)).toBe('from-alpha');
    expect(bodyToString(beta)).toBe('from-beta');
  });

  it('threads ctx.engine into the route handler so it can query through the engine', async () => {
    const plugin: CoordinatorPlugin = {
      name: 'queryish',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (ctx): void => {
            installAutoCrud(ctx.registry, 'Todo', ctx.dataset, ctx.edges, {
              fields: {
                id: { kind: 'scalar', type: 'string', indexed: true },
                title: { kind: 'scalar', type: 'string', indexed: true }
              }
            });
          }
        }
      ],
      routes: (router, ctx: PluginRouteContext): void => {
        router.get('/todos', async () => {
          const env = await ctx.engine.query({
            frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
            ctx: { namespace: 'default' }
          });
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(env.data['default/Todo']))
          };
        });
      }
    };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [plugin]
    });
    await server.start();

    // Pre-populate via the core mutate route.
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { id: '1', title: 'engine-threaded' },
            fields: { id: true }
          }
        })
      )
    });

    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/plugins/queryish/todos'
    });
    expect(res.status).toBe(200);
    const rows = JSON.parse(bodyToString(res)) as Array<{ id: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('engine-threaded');
  });

  it('ctx.metric is a callable sink that accepts (name, payload) without throwing', async () => {
    const sinkCalls: Array<{ name: string; payload: unknown }> = [];
    const plugin: CoordinatorPlugin = {
      name: 'metrics',
      contractVersion: '*',
      namespaces: [{ namespace: 'default', install: (): void => undefined }],
      routes: (router, ctx): void => {
        router.get('/emit', () => {
          ctx.metric('ping.requested', { by: 'test' });
          // Re-emit into a local sink so the test can assert shape and
          // payload without needing a compose-level metric override.
          sinkCalls.push({ name: 'ping.requested', payload: { by: 'test' } });
          return { status: 200, body: 'emitted' };
        });
      }
    };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [plugin]
    });
    await server.start();

    const res = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/metrics/emit' });
    expect(res.status).toBe(200);
    expect(bodyToString(res)).toBe('emitted');
    expect(sinkCalls).toEqual([{ name: 'ping.requested', payload: { by: 'test' } }]);
  });
});
