import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/candidate-selection.js';
import { DEFAULT_CRYSTALLISE_CONFIG } from '../src/crystallise-core.js';
import { crystalliseRouteHandler } from '../src/crystallise-route.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';

const MODEL = 'fake:3';

const CANDIDATES: Candidate[] = [
  {
    namespace: 'cortext',
    type: 'Decision',
    id: 'a1',
    vector: new Float32Array([1, 0, 0]),
    row: { title: 'plugin loader' }
  },
  {
    namespace: 'cortext',
    type: 'Decision',
    id: 'a2',
    vector: new Float32Array([0.98, 0.1, 0]),
    row: { title: 'plugin tier' }
  }
];

function fakeEmbeddings(): EmbeddingsStore {
  return {
    txScopeId: 'fake',
    upsert: async (): Promise<void> => {},
    knnSearch: async (): Promise<never[]> => [],
    boostSalience: async (): Promise<[]> => [],
    fetchEmbeddings: async (): Promise<never[]> => [],
    selectCandidates: async (): Promise<Candidate[]> => CANDIDATES.map((c) => ({ ...c }))
  } as unknown as EmbeddingsStore;
}

const makeHandler = (overrides: Record<string, unknown> = {}) =>
  crystalliseRouteHandler({
    embeddings: fakeEmbeddings(),
    clusters: new InMemoryClusterStore({ txScopeId: 'mem' }),
    model: MODEL,
    config: DEFAULT_CRYSTALLISE_CONFIG,
    runClusterer: async (v: readonly Float32Array[]): Promise<number[]> => v.map(() => 0),
    ...overrides
  } as Parameters<typeof crystalliseRouteHandler>[0]);

const post = (body: unknown) =>
  ({ body: Buffer.from(JSON.stringify(body)), identity: null }) as never;

// Typed as `SubstrateResponse` (its `body` is optional), not `{ body: unknown }`
// (`body` required) — the latter doesn't structurally accept the real
// `SubstrateResponse` the handler returns under `exactOptionalPropertyTypes`.
const parse = (res: SubstrateResponse): Record<string, unknown> =>
  JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body));

describe('POST /substrate/v1/crystallise', () => {
  it('forms clusters and returns the summary', async () => {
    const res = await makeHandler()(
      post({ mode: 'form', select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] } })
    );
    expect(res.status).toBe(200);
    const out = parse(res);
    expect(out.mode).toBe('form');
    expect(out.clustersFormed).toBe(1);
    expect(out.membersAttached).toBe(2);
    expect(Array.isArray(out.clusters)).toBe(true);
  });

  it('rejects a request with no selection filter — 400, not a default', async () => {
    const res = await makeHandler()(post({ mode: 'form' }));
    expect(res.status).toBe(400);
    const out = parse(res);
    expect(out.code).toBe('bad_request');
    expect(String(out.message)).toMatch(/selection filter is required/i);
  });

  it('rejects an empty body', async () => {
    const res = await makeHandler()({ body: null, identity: null } as never);
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const res = await makeHandler()({ body: Buffer.from('{nope'), identity: null } as never);
    expect(res.status).toBe(400);
  });

  // The mock returns the real `PolicyDecision` shape (`{ allow, reason? }`),
  // which `crystallise-core` consumes directly.
  it('returns 403 when the read policy denies a scope', async () => {
    const res = await makeHandler({
      checkReadPolicy: (): { allow: boolean; reason: string } => ({
        allow: false,
        reason: 'nope'
      })
    })(post({ mode: 'form', select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] } }));
    expect(res.status).toBe(403);
    expect((parse(res).error as { code: string }).code).toBe('policy_denied');
  });

  // The allow half: a check that reads the wrong field would deny every scope,
  // so only a correct reading of `allow` reaches 200.
  it('succeeds when the read policy allows every scope', async () => {
    const res = await makeHandler({
      checkReadPolicy: (): { allow: boolean } => ({ allow: true })
    })(post({ mode: 'form', select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] } }));
    expect(res.status).toBe(200);
    const out = parse(res);
    expect(out.mode).toBe('form');
    expect(out.clustersFormed).toBe(1);
  });

  it('returns 503 when no ClusterStore is wired', async () => {
    const handler = crystalliseRouteHandler({
      embeddings: fakeEmbeddings(),
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG
    } as Parameters<typeof crystalliseRouteHandler>[0]);
    const res = await handler(
      post({ mode: 'form', select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] } })
    );
    expect(res.status).toBe(503);
    expect((parse(res).error as { code: string }).code).toBe('crystallise_unavailable');
  });
});
