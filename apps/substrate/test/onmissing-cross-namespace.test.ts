/**
 * Cross-namespace onMissing:'reject' end-to-end coverage.
 *
 * Drives `assertCrossRefTargetsExist` through the real engine: the engine's
 * own `resolveDataset` closure resolving a genuine SIBLING dataset, via
 * `/substrate/v1/mutate` + `/substrate/v1/query`. Unit tests cover the closure threading and
 * the helper against a stub; this seam only lights up when a `reject` crossRef
 * targets a namespace OTHER than the one being written (the shared
 * fixture-plugin's `Owner`/`Target` pair is same-namespace and short-circuits
 * to `args.dataset`).
 *
 * Its own compose() rather than a namespace added to the shared
 * `_fixtures/fixture-plugin.ts`, whose consumers assert an EXACT
 * federated-schema namespace list.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { field, installAutoCrud } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  PackEnvelope,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

function asJsonRequest(path: string, payload: Record<string, unknown>): Partial<SubstrateRequest> {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  };
}

/** `default` namespace — hosts `Owner`, whose crossRef targets the SIBLING `other` namespace. */
const ownerPlugin: CoordinatorPlugin = {
  name: 'cross-ns-owner',
  contractVersion: '*',
  namespaces: [
    {
      namespace: 'default',
      install: (ctx): void => {
        installAutoCrud(ctx.registry, 'Owner', ctx.dataset, ctx.edges, {
          fields: {
            id: { kind: 'scalar', type: 'string', indexed: true },
            ref: field.crossRef('other', 'Thing', { onMissing: 'reject' })
          }
        });
      }
    }
  ]
};

/** `other` namespace — hosts `Thing`, the cross-ns referent for `default/Owner.ref`. */
const thingPlugin: CoordinatorPlugin = {
  name: 'cross-ns-thing',
  contractVersion: '*',
  namespaces: [
    {
      namespace: 'other',
      install: (ctx): void => {
        installAutoCrud(ctx.registry, 'Thing', ctx.dataset, ctx.edges, {
          fields: {
            id: { kind: 'scalar', type: 'string', indexed: true }
          }
        });
      }
    }
  ]
};

describe("cross-namespace onMissing:'reject' enforcement, end-to-end", () => {
  let server: MemorySubstrateServer;
  let dataset: MemoryDataset;
  let composed: ComposeResult;

  beforeEach(async () => {
    server = new MemorySubstrateServer();
    dataset = new MemoryDataset({ namespace: 'default' });
    // No explicit `datasets: { other: ... }` override — compose()'s
    // auto-allocation factory (`opts.dataset.forNamespace(ns)`) provisions a
    // real sibling in-memory dataset for `other` on first lookup, so the
    // engine's `resolveDataset` closure resolves a genuine dataset instance.
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [ownerPlugin, thingPlugin]
    });
    await server.start();
  });

  afterEach(async () => {
    await composed.stop();
  });

  it('create succeeds when the cross-namespace target exists', async () => {
    const createThing = await server.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'other/createThing': { params: { id: 'thing-1' }, fields: { id: true } }
      })
    );
    expect(jsonBody<PackEnvelope>(createThing).errors).toBeUndefined();

    const createOwner = await server.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createOwner': {
          params: { id: 'owner-1', ref: 'thing-1' },
          fields: { id: true }
        }
      })
    );
    const env = jsonBody<PackEnvelope>(createOwner);
    expect(env.errors).toBeUndefined();
    expect(env.data['default/createOwner']).toMatchObject({ id: 'owner-1' });
  });

  it('create is rejected with missing_referent when the cross-namespace target is absent, and writes no row', async () => {
    const createOwner = await server.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createOwner': {
          params: { id: 'owner-2', ref: 'ghost' },
          fields: { id: true }
        }
      })
    );
    const env = jsonBody<PackEnvelope>(createOwner);
    expect(env.errors?.[0]?.code).toBe('missing_referent');
    // The failed create must not surface a data payload alongside the error.
    expect(env.data['default/createOwner']).toBeUndefined();

    const check = await server.inject(
      asJsonRequest('/substrate/v1/query', {
        'default/Owner': { params: { where: { id: { eq: 'owner-2' } } }, fields: { id: true } }
      })
    );
    expect(jsonBody<PackEnvelope>(check).data['default/Owner']).toHaveLength(0);
  });
});
