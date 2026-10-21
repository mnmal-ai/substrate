import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from '../src/fake.js';

describe('FakeEmbedder', () => {
  it('produces a vector of the configured dimension', async () => {
    const e = new FakeEmbedder({ dimension: 384 });
    const v = await e.embed('hello');
    expect(v.length).toBe(384);
    expect(v).toBeInstanceOf(Float32Array);
  });

  it('is deterministic: same input produces same vector', async () => {
    const e = new FakeEmbedder({ dimension: 64 });
    const v1 = await e.embed('decision about auth tokens');
    const v2 = await e.embed('decision about auth tokens');
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it('produces different vectors for different inputs', async () => {
    const e = new FakeEmbedder({ dimension: 64 });
    const v1 = await e.embed('auth tokens');
    const v2 = await e.embed('session memory');
    expect(Array.from(v1)).not.toEqual(Array.from(v2));
  });

  it('modelId encodes dimension', () => {
    const e = new FakeEmbedder({ dimension: 384 });
    expect(e.modelId).toBe('fake:v1:384');
    expect(e.dimension).toBe(384);
  });

  it('empty string is handled (returns a valid vector, not an error)', async () => {
    const e = new FakeEmbedder({ dimension: 8 });
    const v = await e.embed('');
    expect(v.length).toBe(8);
  });
});
