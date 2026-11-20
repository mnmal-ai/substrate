/**
 * A namespace proposed at runtime gets its datasets from `forNamespace` on the
 * default one. Each such handle answers field definitions for its own
 * namespace: a proposed number field sorts as a number, and a walk over a
 * proposed crossRef resolves.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { compose, SYSTEM_NAMESPACE, signHs256 } from '@mnmal-ai/substrate-compose';
import type { Engine } from '@mnmal-ai/substrate-core';
import {
  createNoopPubSub,
  createProposalsPlugin,
  storageSettled
} from '@mnmal-ai/substrate-proposals';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  makeFieldDefLookupFactory,
  makeTypeDefLookupFactory,
  wireStore
} from '../src/serve/wiring.js';
import { deleteNamespaces } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const SECRET = 'fielddef-per-namespace-secret';
const CONTROL = '_system_proposals';
const NS = 'kfdrt';

type Wired = Awaited<ReturnType<typeof wireStore>>;

describe.skipIf(!POSTGRES_URL)('field definitions of a runtime namespace (pg)', () => {
  let wired: Wired;
  const stops: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    let engine: Engine | undefined;
    wired = await wireStore(
      POSTGRES_URL as string,
      makeFieldDefLookupFactory(new Map(), (ns) => engine?.registryFor(ns)),
      makeTypeDefLookupFactory(new Map(), (ns) => engine?.registryFor(ns))
    );
    engineRef = (e) => {
      engine = e;
    };
  });
  let engineRef: (e: Engine) => void = () => undefined;

  afterEach(async () => {
    while (stops.length > 0) await stops.pop()?.();
    if (wired.sql !== null) await deleteNamespaces(wired.sql, NS, CONTROL);
  });

  afterAll(async () => {
    await wired.close?.();
  });

  async function boot() {
    if (wired.sql !== null) await deleteNamespaces(wired.sql, NS, CONTROL);
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: wired.dataset,
      edges: wired.edges,
      datasets: wired.substrateNamespaceDataset
        ? { [SYSTEM_NAMESPACE]: wired.substrateNamespaceDataset }
        : {},
      coordinators: [createProposalsPlugin({ ownedNamespaces: [], pubsub: createNoopPubSub() })],
      auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' }
    });
    engineRef(composed.engine);
    await server.start();
    stops.push(async () => {
      await composed.stop();
      await server.stop();
    });
    const token = signHs256(
      {
        sub: 'op',
        exp: Math.floor(Date.now() / 1000) + 300,
        capabilities: ['admin', 'read', 'mutate', 'substrate.propose'],
        ns: ['*']
      },
      SECRET,
      { kid: 'file' }
    );
    const post = async (path: string, body: unknown) => {
      const res = await server.inject({
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: Buffer.from(JSON.stringify(body))
      });
      const parsed = JSON.parse(String(res.body)) as {
        data?: Record<string, unknown>;
        errors?: unknown[];
      };
      expect(parsed.errors ?? [], String(res.body)).toEqual([]);
      return parsed.data ?? {};
    };
    const mutate = (frame: Record<string, unknown>) => post('/substrate/v1/mutate', frame);
    await mutate({
      [`${CONTROL}/propose_namespace`]: {
        params: { ns: NS, proposedReason: 'test' },
        fields: { id: true }
      }
    });
    await mutate({
      [`${NS}/propose_type`]: {
        params: {
          typeName: 'Item',
          fields: { label: { kind: 'scalar', type: 'string' } },
          proposedReason: 'test'
        },
        fields: { id: true }
      }
    });
    await storageSettled();
    // Added to a live type, so both wait pending: nothing but the registry knows their kinds.
    for (const [fieldName, fieldSpec] of [
      ['rank', { kind: 'scalar', type: 'number' }],
      ['parent', { kind: 'crossRef', ns: NS, type: 'Item', onDelete: 'set_null' }]
    ] as const) {
      await mutate({
        [`${NS}/propose_field`]: {
          params: { targetType: 'Item', fieldName, fieldSpec, proposedReason: 'test' },
          fields: { id: true }
        }
      });
    }
    await storageSettled();
    const created = await mutate({
      [`${NS}/createItem`]: [
        { params: { label: 'x', rank: 10 }, fields: { id: true } },
        { params: { label: 'x', rank: 9 }, fields: { id: true } }
      ]
    });
    const [, nine] = created[`${NS}/createItem`] as Array<{ id: string }>;
    const child = await mutate({
      [`${NS}/createItem`]: {
        params: { label: 'x', rank: 1, parent: (nine as { id: string }).id },
        fields: { id: true }
      }
    });
    return {
      query: (frame: Record<string, unknown>) => post('/substrate/v1/query', frame),
      childId: (child[`${NS}/createItem`] as { id: string }).id
    };
  }

  it('sorts a proposed number field numerically in a runtime namespace', async () => {
    const { query } = await boot();
    const data = await query({
      [`${NS}/Item`]: {
        params: { where: { rank: { gt: 5 } }, orderBy: [{ rank: 'asc' }] },
        fields: { rank: true }
      }
    });
    expect((data[`${NS}/Item`] as Array<{ rank: number }>).map((r) => r.rank)).toEqual([9, 10]);
  });

  it('walks a proposed crossRef in a runtime namespace', async () => {
    const { query, childId } = await boot();
    const data = await query({
      [`${NS}/Item`]: {
        params: {
          where: { _walk: { out: 'parent', quantifier: 'any', where: { rank: { eq: 9 } } } }
        },
        fields: { id: true }
      }
    });
    expect(data[`${NS}/Item`]).toEqual([{ id: childId }]);
  });
});
