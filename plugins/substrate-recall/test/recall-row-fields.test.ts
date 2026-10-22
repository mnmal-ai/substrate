/**
 * Each hit's row carries `id` plus its handle fields unless the caller asks for
 * more, on every recall surface: the frame (a nested `fields: { row: { … } }`,
 * or `row: true`), the route and the plugin MCP tool (`rowFields`). The core
 * does the narrowing and refuses a malformed value with `bad_request` the same
 * way everywhere.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import { isResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

const BODY = { id: 'n1', synopsis: 'short handle', body: 'a long body nobody asked for' };

function setup() {
  const store = {
    txScopeId: 'test',
    upsert: async () => {},
    delete: async () => {},
    knnSearch: async () => [{ row: { ...BODY }, score: 0.9, salience: 0 }],
    boostSalience: async () => [],
    fetchEmbeddings: async () => [],
    selectCandidates: async () => []
  } as unknown as EmbeddingsStore;
  return createRecallPlugin({ embedder: new FakeEmbedder({ dimension: 8 }), store });
}

const ctx: RequestContext = {
  identity: null,
  namespace: 'recall',
  operation: 'query',
  now: new Date(),
  headers: {},
  meta: {}
};

const BASE = { namespace: 'ns', type: 'Note', boost: false };

async function frame(fields: Record<string, unknown> | undefined) {
  const hit = setup().kernelNamespace?.types?.Hit;
  return Promise.resolve(
    hit?.resolver(ctx, { params: { to: 'q', ...BASE }, ...(fields ? { fields } : {}) })
  ) as Promise<Array<Record<string, unknown>>>;
}

async function route(body: Record<string, unknown>) {
  const r = setup().kernelRoutes?.find((x) => x.path === 'recall');
  const res = await Promise.resolve(
    r!.handler({
      method: 'POST',
      path: '/substrate/v1/recall',
      headers: {},
      query: {},
      params: {},
      body: Buffer.from(JSON.stringify({ query: 'q', ...BASE, ...body }))
    })
  );
  return { status: res.status, body: JSON.parse(String(res.body)) };
}

async function mcp(input: Record<string, unknown>) {
  const tool = setup().mcpTools?.find((t) => t.name === 'recall');
  return (await tool!.handler({ query: 'q', ...BASE, ...input })) as {
    rows?: Array<{ row: Record<string, unknown> }>;
    error?: { code?: string; message?: string };
  };
}

describe('the recall/Hit frame', () => {
  it('narrows row to a nested selection, keeping id', async () => {
    const rows = await frame({ id: true, score: true, row: { synopsis: true } });
    expect(rows[0]).toEqual({ id: 'n1', score: 0.9, row: { id: 'n1', synopsis: 'short handle' } });
  });

  it('returns id plus handle fields when fields are unprojected', async () => {
    const rows = await frame(undefined);
    expect(rows[0]?.row).toEqual({ id: 'n1', synopsis: 'short handle' });
  });

  it('returns the whole body for row: true', async () => {
    const rows = await frame({ id: true, row: true });
    expect(rows[0]?.row).toEqual(BODY);
  });

  it('refuses a non-true row selection with bad_request', async () => {
    const err = await frame({ row: { synopsis: 1 } }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isResolverFrameError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/rowFields/) });
  });
});

describe('POST /substrate/v1/recall', () => {
  it('narrows each row to rowFields plus id', async () => {
    const res = await route({ rowFields: { synopsis: true } });
    expect(res.status).toBe(200);
    expect(res.body.rows[0].row).toEqual({ id: 'n1', synopsis: 'short handle' });
  });

  it('returns id plus handle fields without rowFields', async () => {
    const res = await route({});
    expect(res.body.rows[0].row).toEqual({ id: 'n1', synopsis: 'short handle' });
  });

  it('returns the whole body for rowFields: true', async () => {
    const res = await route({ rowFields: true });
    expect(res.body.rows[0].row).toEqual(BODY);
  });

  for (const rowFields of [['synopsis'], { synopsis: false }, 'synopsis', false]) {
    it(`refuses rowFields ${JSON.stringify(rowFields)} with 400 bad_request`, async () => {
      const res = await route({ rowFields });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'bad_request',
        message: expect.stringMatching(/rowFields/)
      });
    });
  }
});

describe('the recall plugin MCP tool', () => {
  it('narrows each row to rowFields plus id', async () => {
    const out = await mcp({ rowFields: { synopsis: true, body: true } });
    expect(out.error).toBeUndefined();
    expect(out.rows?.[0]?.row).toEqual(BODY);
    const narrow = await mcp({ rowFields: { synopsis: true } });
    expect(narrow.rows?.[0]?.row).toEqual({ id: 'n1', synopsis: 'short handle' });
  });

  it('returns id plus handle fields by default', async () => {
    const out = await mcp({});
    expect(out.rows?.[0]?.row).toEqual({ id: 'n1', synopsis: 'short handle' });
  });

  it('refuses a malformed rowFields with bad_request', async () => {
    const out = await mcp({ rowFields: ['synopsis'] });
    expect(out.error).toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/rowFields/)
    });
  });
});
