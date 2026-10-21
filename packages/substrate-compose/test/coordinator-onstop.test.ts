/**
 * Compose-level integration test for the coordinator `onStop` lifecycle hook.
 *
 * The `stop()` function returned by `compose()` MUST fire `runOnStop` against
 * every coordinator that declared it, in reverse registration order, before
 * the server stops accepting connections.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

describe('compose() — coordinator onStop lifecycle hook', () => {
  it('fires every plugin onStop when stop() is called, in reverse registration order', async () => {
    const torn: string[] = [];
    const first: CoordinatorPlugin = {
      name: 'first',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'first-ns',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStop: async () => {
        torn.push('first');
      }
    };
    const second: CoordinatorPlugin = {
      name: 'second',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'second-ns',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStop: async () => {
        torn.push('second');
      }
    };

    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [first, second]
    });
    await server.start();

    expect(torn).toEqual([]);
    await composed.stop();
    // Reverse registration: second tears down before first.
    expect(torn).toEqual(['second', 'first']);
  });

  it('skips plugins without onStop (no-op, no error)', async () => {
    const tornCalled: string[] = [];
    const withHook: CoordinatorPlugin = {
      name: 'with-hook',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'with',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStop: async () => {
        tornCalled.push('with-hook');
      }
    };
    const withoutHook: CoordinatorPlugin = {
      name: 'without-hook',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'without',
          install: async () => {
            /* noop */
          }
        }
      ]
      // no onStop declared
    };

    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [withHook, withoutHook]
    });
    await server.start();
    await composed.stop();
    expect(tornCalled).toEqual(['with-hook']);
  });

  it("a throwing plugin's onStop does not block the rest of stop() from completing", async () => {
    const tornCalled: string[] = [];
    const throwsOnStop: CoordinatorPlugin = {
      name: 'throws',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'throws-ns',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStop: async () => {
        throw new Error('teardown failed');
      }
    };
    const cleanPlugin: CoordinatorPlugin = {
      name: 'clean',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'clean-ns',
          install: async () => {
            /* noop */
          }
        }
      ],
      onStop: async () => {
        tornCalled.push('clean');
      }
    };

    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [cleanPlugin, throwsOnStop]
    });
    await server.start();
    // stop() resolves cleanly even though one plugin's onStop threw.
    await expect(composed.stop()).resolves.toBeUndefined();
    // The non-throwing plugin's onStop still ran.
    expect(tornCalled).toEqual(['clean']);
  });
});
