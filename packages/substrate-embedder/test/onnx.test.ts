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
    // An engine that never yields: the timeout is the only way out.
    (e as unknown as { engine: unknown }).engine = {
      embed: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })
    };
    await expect(e.embed('x', { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'EmbedError',
      code: 'unavailable'
    });
  });
});
