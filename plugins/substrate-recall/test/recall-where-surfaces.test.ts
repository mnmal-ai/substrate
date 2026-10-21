/**
 * `where` reaches the recall core from the frame, the route and the plugin
 * MCP tool. Each surface admits the param; the core validates it, so a
 * malformed filter is refused `bad_request` the same way everywhere.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import { isResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { EmbeddingsStore, EmbeddingsStoreKnnInput } from '../src/embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

const VALID = { project: { in: ['beta', null] } };
const MALFORMED = [{ project: 'beta' }, { 'bad-field': { eq: 1 } }];

function setup() {
  const knnCalls: EmbeddingsStoreKnnInput[] = [];
  const store = {
    txScopeId: 'test',
    upsert: async () => {},
    delete: async () => {},
    knnSearch: async (input: EmbeddingsStoreKnnInput) => {
      knnCalls.push(input);
      return [];
    },
    boostSalience: async () => [],
    fetchEmbeddings: async () => [],
    selectCandidates: async () => []
  } as unknown as EmbeddingsStore;
  const plugin = createRecallPlugin({ embedder: new FakeEmbedder({ dimension: 8 }), store });
  return { plugin, knnCalls };
}

const ctx: RequestContext = {
  identity: null,
  namespace: 'recall',
  operation: 'query',
  now: new Date(),
  headers: {},
  meta: {}
};

async function frame(params: Record<string, unknown>) {
  const { plugin, knnCalls } = setup();
  const hit = plugin.kernelNamespace?.types?.Hit;
  const outcome = await Promise.resolve(
    hit?.resolver(ctx, { params: { to: 'q', namespace: 'ns', type: 'Note', ...params } })
  ).then(
    () => undefined,
    (e: unknown) => e
  );
  return { err: outcome, knnCalls };
}

async function route(body: Record<string, unknown>) {
  const { plugin, knnCalls } = setup();
  const r = plugin.kernelRoutes?.find((x) => x.path === 'recall');
  const res = await Promise.resolve(
    r!.handler({
      method: 'POST',
      path: '/substrate/v1/recall',
      headers: {},
      query: {},
      params: {},
      body: Buffer.from(JSON.stringify({ query: 'q', namespace: 'ns', type: 'Note', ...body }))
    })
  );
  return { status: res.status, body: JSON.parse(String(res.body)), knnCalls };
}

async function mcp(input: Record<string, unknown>) {
  const { plugin, knnCalls } = setup();
  const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
  const out = (await tool!.handler({ query: 'q', namespace: 'ns', type: 'Note', ...input })) as {
    error?: { code?: string; message?: string };
  };
  return { out, knnCalls };
}

describe('the recall/Hit frame', () => {
  it('passes a valid where through to the kNN', async () => {
    const { err, knnCalls } = await frame({ where: VALID });
    expect(err).toBeUndefined();
    expect(knnCalls[0]?.rowFilter).toEqual(VALID);
  });

  for (const where of MALFORMED) {
    it(`refuses ${JSON.stringify(where)} with bad_request`, async () => {
      const { err } = await frame({ where });
      expect(isResolverFrameError(err)).toBe(true);
      expect(err).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/"where"/) });
    });
  }
});

describe('POST /substrate/v1/recall', () => {
  it('passes a valid where through to the kNN', async () => {
    const res = await route({ where: VALID });
    expect(res.status).toBe(200);
    expect(res.knnCalls[0]?.rowFilter).toEqual(VALID);
  });

  for (const where of MALFORMED) {
    it(`refuses ${JSON.stringify(where)} with 400 bad_request`, async () => {
      const res = await route({ where });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'bad_request',
        message: expect.stringMatching(/"where"/)
      });
    });
  }
});

describe('the recall plugin MCP tool', () => {
  it('passes a valid where through to the kNN', async () => {
    const { out, knnCalls } = await mcp({ where: VALID });
    expect(out.error).toBeUndefined();
    expect(knnCalls[0]?.rowFilter).toEqual(VALID);
  });

  it('documents where in its input schema', () => {
    const { plugin } = setup();
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
    const props = (tool!.inputSchema as { properties: Record<string, { type?: string }> })
      .properties;
    expect(props.where?.type).toBe('object');
  });

  for (const where of MALFORMED) {
    it(`refuses ${JSON.stringify(where)} with bad_request`, async () => {
      const { out } = await mcp({ where });
      expect(out.error).toMatchObject({
        code: 'bad_request',
        message: expect.stringMatching(/"where"/)
      });
    });
  }
});
