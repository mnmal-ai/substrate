/**
 * `compose()` threads its `routeMetric` sink into plugin lifecycle hooks, so a
 * `ctx.metric` call inside `plugin.onStart` / `plugin.onStop` reaches the same
 * `process.stdout` sink as routes rather than a no-op. The test captures the
 * metric callback handed to the hooks and exercises it with the test-mode
 * silencer disabled.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compose } from '../src/compose.js';

describe('compose() — plugin lifecycle metric sink', () => {
  let prevNodeEnv: string | undefined;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // routeMetric short-circuits when NODE_ENV === 'test' so vitest output
    // stays quiet; clear it for these tests so we can actually observe what
    // a plugin's ctx.metric writes.
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    writes = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('threads compose metric sink into plugin onStart (no longer a no-op)', async () => {
    let received: ((name: string, payload?: unknown) => void) | null = null;
    const plugin: CoordinatorPlugin = {
      name: 'lifecycle-start',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'lifecycle-start',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStart: async (ctx) => {
        received = ctx.metric;
      }
    };

    await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [plugin]
    });

    expect(received).not.toBeNull();
    // Invoke the captured metric and verify the compose-level routeMetric
    // sink produced the expected stdout line.
    (received as unknown as (name: string, payload?: unknown) => void)('home.heartbeat.tick', {
      count: 1
    });
    expect(writes.join('')).toContain('plugin.home.heartbeat.tick {"count":1}');
  });

  it('threads compose metric sink into plugin onStop', async () => {
    let received: ((name: string, payload?: unknown) => void) | null = null;
    const plugin: CoordinatorPlugin = {
      name: 'lifecycle-stop',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'lifecycle-stop',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStop: async (ctx) => {
        received = ctx.metric;
      }
    };

    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [plugin]
    });
    await composed.stop();

    expect(received).not.toBeNull();
    (received as unknown as (name: string, payload?: unknown) => void)('home.shutdown', {
      reason: 'sigterm'
    });
    expect(writes.join('')).toContain('plugin.home.shutdown {"reason":"sigterm"}');
  });
});
