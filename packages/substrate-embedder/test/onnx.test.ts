import { describe, expect, it } from 'vitest';
import { OnnxEmbedder } from '../src/onnx.js';

describe('OnnxEmbedder', () => {
  it('constructs with a supported model + dimension', () => {
    const e = new OnnxEmbedder({ model: 'bge-small-en-v1.5', dimension: 384 });
    expect(e.modelId).toBe('bge-small-en-v1.5:384');
    expect(e.dimension).toBe(384);
  });

  it('encodes dimension into modelId so same-family different-dim do not collide', () => {
    const a = new OnnxEmbedder({ model: 'bge-base-en-v1.5', dimension: 768 });
    const b = new OnnxEmbedder({ model: 'bge-small-en-v1.5', dimension: 384 });
    expect(a.modelId).not.toBe(b.modelId);
  });

  it('throws on unsupported model', () => {
    expect(() => new OnnxEmbedder({ model: 'unknown-model', dimension: 768 })).toThrow(
      /unknown model/i
    );
  });

  it('accepts custom cacheDir + maxLength', () => {
    const e = new OnnxEmbedder({
      model: 'all-MiniLM-L6-v2',
      dimension: 384,
      cacheDir: '/tmp/onnx-test-cache',
      maxLength: 256
    });
    expect(e.modelId).toBe('all-MiniLM-L6-v2:384');
  });

  it('honours timeoutMs, rejecting with an unavailable EmbedError', async () => {
    const e = new OnnxEmbedder({ model: 'all-MiniLM-L6-v2', dimension: 384 });
    // A session that never answers: the timeout is the only way out.
    (e as unknown as { engine: unknown }).engine = {
      tokenizer: { encode: () => ({ ids: [1, 2], token_type_ids: [0, 0] }) },
      session: { inputNames: ['input_ids', 'attention_mask'], run: () => new Promise(() => {}) },
      ort: { Tensor: class {} },
      maxLength: 512
    };
    await expect(e.embed('x', { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'EmbedError',
      code: 'unavailable'
    });
  });

  /** An embedder whose model is a stub answering `hidden` (tokens x width) for whatever it is fed. */
  function stubbed(model: string, dimension: number, ids: number[], maxLength = 512) {
    const fed: Array<Record<string, { data: BigInt64Array; dims: number[] }>> = [];
    const e = new OnnxEmbedder({ model, dimension });
    (e as unknown as { engine: unknown }).engine = {
      tokenizer: { encode: () => ({ ids, token_type_ids: ids.map(() => 0) }) },
      session: {
        inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
        run: async (feeds: Record<string, { data: BigInt64Array; dims: number[] }>) => {
          fed.push(feeds);
          const tokens = feeds.input_ids?.dims[1] ?? 0;
          // Token t holds the value t + 1 in every position.
          const data = Float32Array.from(
            { length: tokens * dimension },
            (_, k) => Math.floor(k / dimension) + 1
          );
          return { last_hidden_state: { data, dims: [1, tokens, dimension] } };
        }
      },
      ort: {
        Tensor: class {
          constructor(
            readonly type: string,
            readonly data: BigInt64Array,
            readonly dims: number[]
          ) {}
        }
      },
      maxLength
    };
    return { e, fed };
  }

  it('returns a unit vector of the declared width, from the first token or the mean', async () => {
    for (const model of ['bge-small-en-v1.5', 'all-MiniLM-L6-v2']) {
      const { e } = stubbed(model, 384, [101, 7592, 2088, 102]);
      const v = await e.embed('hello world');
      expect(v).toHaveLength(384);
      // Every position is equal in the stub, so the unit vector is 1/sqrt(width) throughout.
      expect(v[0]).toBeCloseTo(1 / Math.sqrt(384), 6);
      expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    }
  });

  it('truncates to maxLength and keeps the closing token', async () => {
    const ids = [101, 1, 2, 3, 4, 5, 6, 102];
    const { e, fed } = stubbed('bge-small-en-v1.5', 384, ids, 5);
    await e.embed('long text');
    expect(Array.from(fed[0]?.input_ids?.data ?? [], Number)).toEqual([101, 1, 2, 3, 102]);
    expect(Array.from(fed[0]?.attention_mask?.data ?? [], Number)).toEqual([1, 1, 1, 1, 1]);
    expect(fed[0]?.token_type_ids?.dims).toEqual([1, 5]);
  });

  it('refuses a model whose width is not the declared dimension', async () => {
    const { e } = stubbed('bge-small-en-v1.5', 384, [101, 102]);
    (e as unknown as { dimension: number }).dimension = 768;
    await expect(e.embed('x')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
