/**
 * compose()-time registration guard: a crossRef declaring
 * `onMissing:'reject'` requires its target namespace to be locally resolvable.
 * There is no write-time existence check against bridged/remote targets, so a
 * misconfigured `reject` must fail loud at boot rather than silently degrade
 * to "never rejects" at write time.
 *
 * The guard detects a non-local target via `datasets.has(ns)`, which
 * reports only whether a dataset has already been `set()` into the
 * registry — it does not invoke the registry's auto-allocating factory.
 * So any plain unregistered namespace name (no plugin claims it, no
 * dataset provisions it) exercises the "non-local" branch; no bridge
 * stub is required to gate the factory.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin, NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

function makeCoordinatorPlugin(name: string, nsDef: NamespaceDefinition): CoordinatorPlugin {
  return {
    name,
    contractVersion: '*',
    namespaces: [nsDef]
  };
}

/** `app/Widget.ref` crossRef's `onMissing:'reject'` at whatever `targetNs` names. */
function widgetNamespace(targetNs: string): NamespaceDefinition {
  return defineNamespace('app', {
    Widget: {
      fields: {
        id: field.string(),
        ref: field.crossRef(targetNs, 'Thing', { onMissing: 'reject' })
      }
    }
  });
}

describe('compose() registration-time reject for onMissing', () => {
  it('composes when the reject target namespace is local (app -> app)', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [makeCoordinatorPlugin('rejecter', widgetNamespace('app'))]
    });

    await server.start();
    try {
      expect(composed).toBeDefined();
    } finally {
      await composed.stop();
    }
  });

  it('refuses to compose when the reject target namespace is unregistered', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server,
        dataset,
        coordinators: [makeCoordinatorPlugin('rejecter', widgetNamespace('unregistered_ns'))]
      })
    ).rejects.toThrow(/onmissing_reject_requires_local_target/);
  });
});
