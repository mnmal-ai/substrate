/**
 * Query-time embeds (recall, embeddingSimilar) run under a short per-call
 * timeout, so a stalled embedder answers 503 instead of holding the caller
 * for the embedder's write-path timeout.
 */

import { type Embedder, EmbedError } from '@mnmal-ai/substrate-embedder';
import type {
  NamespaceDefinition,
  RequestContext,
  Row,
  SubstrateRequest
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { RecallBootstrapConfigSchema } from '../src/bootstrap.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

/** Never answers; rejects only when the caller passes a timeout. */
function stalledEmbedder(seen: Array<number | undefined>): Embedder {
  return {
    modelId: 'stall:v1:8',
    dimension: 8,
    embed: (_text, opts) => {
      seen.push(opts?.timeoutMs);
      return new Promise((_resolve, reject) => {
        if (opts?.timeoutMs !== undefined) {
          setTimeout(
            () => reject(new EmbedError('unavailable', `timed out after ${opts.timeoutMs}ms`)),
            opts.timeoutMs
          );
        }
      });
    }
  };
}

function recallRoute(plugin: ReturnType<typeof createRecallPlugin>) {
  const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');
  if (route === undefined) throw new Error('recall route not registered');
  return route;
}

function recallReq(): SubstrateRequest {
  return {
    method: 'POST',
    path: '/substrate/v1/recall',
    headers: { 'content-type': 'application/json' },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify({ query: 'q', namespace: 'cortext', type: 'Memory' }))
  };
}

describe('query-time embed timeout', () => {
  it('answers 503 embedder_unavailable at queryEmbedTimeoutMs when the embedder stalls', async () => {
    const seen: Array<number | undefined> = [];
    const plugin = createRecallPlugin({
      embedder: stalledEmbedder(seen),
      store: new InMemoryEmbeddingsStore(),
      queryEmbedTimeoutMs: 50
    });
    const t0 = Date.now();
    const res = await recallRoute(plugin).handler(recallReq());
    expect(res.status).toBe(503);
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.error.code).toBe('embedder_unavailable');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(seen).toEqual([50]);
  });

  it('defaults the query timeout to 30s', async () => {
    const seen: Array<number | undefined> = [];
    const plugin = createRecallPlugin({
      embedder: {
        modelId: 'ok:v1:8',
        dimension: 8,
        embed: async (_t, opts) => {
          seen.push(opts?.timeoutMs);
          return new Float32Array(8);
        }
      },
      store: new InMemoryEmbeddingsStore()
    });
    await recallRoute(plugin).handler(recallReq());
    expect(seen).toEqual([30_000]);
  });

  it('accepts queryEmbedTimeoutMs in the bootstrap config, defaulting to 30000', () => {
    expect(RecallBootstrapConfigSchema.parse({}).queryEmbedTimeoutMs).toBe(30_000);
    expect(RecallBootstrapConfigSchema.safeParse({ queryEmbedTimeoutMs: 0 }).success).toBe(false);
  });
});

describe('write-time embed timeout', () => {
  // The embed runs as after-commit work the engine awaits, so the write's
  // reply waits on it. It used to run on the embedder's own timeout (120 s
  // live), holding writes that had already committed.
  const ns = {
    namespace: 'cortext',
    types: { Memory: { fields: {}, embed: { source: (r: Row) => String(r.body) } } },
    install: () => {}
  } as unknown as NamespaceDefinition;
  const write = (plugin: ReturnType<typeof createRecallPlugin>) =>
    plugin
      .contributePostWrites?.(ns)
      .Memory?.({ id: 'm1', body: 'b' } as Row, {} as RequestContext);

  it('gives up at writeEmbedTimeoutMs when the embedder stalls', async () => {
    const seen: Array<number | undefined> = [];
    const plugin = createRecallPlugin({
      embedder: stalledEmbedder(seen),
      store: new InMemoryEmbeddingsStore(),
      writeEmbedTimeoutMs: 50
    });
    const t0 = Date.now();
    await write(plugin);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(seen).toEqual([50]);
  });

  it('defaults the write timeout to 30s', async () => {
    const seen: Array<number | undefined> = [];
    const plugin = createRecallPlugin({
      embedder: {
        modelId: 'ok:v1:8',
        dimension: 8,
        embed: async (_t, opts) => {
          seen.push(opts?.timeoutMs);
          return new Float32Array(8);
        }
      },
      store: new InMemoryEmbeddingsStore()
    });
    await write(plugin);
    expect(seen).toEqual([30_000]);
  });

  it('accepts writeEmbedTimeoutMs in the bootstrap config, defaulting to 30000', () => {
    expect(RecallBootstrapConfigSchema.parse({}).writeEmbedTimeoutMs).toBe(30_000);
    expect(RecallBootstrapConfigSchema.safeParse({ writeEmbedTimeoutMs: 0 }).success).toBe(false);
  });
});
