/**
 * Recall refuses parameters it does not understand.
 *
 * Silently dropping them is the defect: with a toggle in the API, "the arm
 * contributed nothing" and "my toggle was never read" produce the same bytes.
 * Subscribe refuses `unknown_param` and names the allowed set the same way.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import { describe, expect, it } from 'vitest';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { parseHitParams } from '../src/frame-surface.js';
import { createRecallPlugin } from '../src/plugin.js';

function store(): EmbeddingsStore {
  return {
    txScopeId: 'test',
    upsert: async () => {},
    delete: async () => {},
    knnSearch: async () => [],
    boostSalience: async () => {}
  } as unknown as EmbeddingsStore;
}

const plugin = () =>
  createRecallPlugin({ embedder: new FakeEmbedder({ dimension: 8 }), store: store() });

const req = (body: unknown) => ({
  method: 'POST' as const,
  path: '/substrate/v1/recall',
  headers: {},
  query: {},
  params: {},
  body: Buffer.from(JSON.stringify(body))
});

async function postRecall(body: unknown) {
  const route = plugin().kernelRoutes?.find((r) => r.path === 'recall');
  const res = await Promise.resolve(route!.handler(req(body)));
  return { status: res.status, body: JSON.parse(String(res.body)) as Record<string, unknown> };
}

describe('POST /substrate/v1/recall rejects unknown params', () => {
  it('refuses a key it does not understand rather than dropping it', async () => {
    const res = await postRecall({ query: 'x', totalNonsenseParam: 123 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('totalNonsenseParam');
  });

  /**
   * The rejection must NAME THE ALLOWED SET, matching subscribe. A refusal
   * that only says "no" sends the caller to the source; one that enumerates
   * cannot go stale, because it is generated from the same list the parser
   * uses.
   */
  it('names the allowed set in the refusal', async () => {
    const res = await postRecall({ query: 'x', nope: 1 });
    const text = JSON.stringify(res.body);
    for (const known of ['query', 'k', 'namespace', 'type', 'lexical', 'explain']) {
      expect(text).toContain(known);
    }
  });

  it('still accepts every parameter it does understand', async () => {
    const res = await postRecall({
      query: 'x',
      k: 3,
      namespace: 'cortext',
      type: 'Memory',
      threshold: 0.1,
      expand: false,
      boost: false,
      returnVector: false,
      lexical: false,
      explain: false
    });
    expect(res.status).toBe(200);
  });

  /**
   * The cross-surface hint must survive. Sending `to` on the ROUTE is the
   * frame's spelling, and that specific confusion has its own message — a
   * generic unknown-param refusal would be a regression in helpfulness on the
   * one mistake most likely to be made.
   */
  it('keeps the "you used the frame spelling" hint for `to`', async () => {
    const res = await postRecall({ to: 'x' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('recall/Hit');
  });
});

describe('the recall/Hit frame rejects unknown params', () => {
  it('refuses a key it does not understand', () => {
    expect(() => parseHitParams({ to: 'x', totalNonsenseParam: 123 })).toThrow(
      /totalNonsenseParam/
    );
  });

  /**
   * The allowed set differs BY SURFACE — the frame spells the search text
   * `to`, the route spells it `query`. A refusal naming the wrong one would
   * send a caller to fix something that is already correct.
   */
  it('names `to` and not `query` in its allowed set', () => {
    let message = '';
    try {
      parseHitParams({ to: 'x', nope: 1 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('to');
    expect(message).not.toMatch(/\bquery\b/);
  });

  it('still accepts the params it does understand', () => {
    expect(() =>
      parseHitParams({ to: 'x', k: 2, namespace: 'n', type: 't', lexical: false })
    ).not.toThrow();
  });
});

describe('the MCP tool rejects unknown params', () => {
  it('refuses rather than silently dropping', async () => {
    const tool = plugin().mcpTools?.find((t) => t.name === 'recall');
    const out = (await tool!.handler({ query: 'x', totalNonsenseParam: 1 })) as {
      error?: { code?: string; message?: string };
    };
    expect(out.error?.message ?? '').toContain('totalNonsenseParam');
  });
});
