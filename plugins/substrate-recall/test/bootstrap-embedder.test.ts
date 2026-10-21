/**
 * Tests for recall's embedder-construction path: the config's `embedder`
 * discriminated union (off | fake | ollama) is turned into an Embedder by
 * bootstrap itself, not received as a hostDep.
 */

import { describe, expect, it } from 'vitest';
import { bootstrap, RecallBootstrapConfigSchema } from '../src/bootstrap.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';

describe('substrate-recall bootstrap: embedder construction', () => {
  it('builds OllamaEmbedder from { kind: "ollama", baseUrl, model, dimension }', () => {
    const plugin = bootstrap(
      {
        embedder: {
          kind: 'ollama',
          baseUrl: 'http://localhost:11434',
          model: 'bge-m3',
          dimension: 1024
        }
      },
      { store: new InMemoryEmbeddingsStore() }
    );
    expect(plugin.name).toBe('substrate-recall');
    // The plugin's filterOperators should be populated (embeddingSimilar is added when embedder is configured)
    expect(plugin.filterOperators).toHaveProperty('embeddingSimilar');
  });

  it('accepts an optional positive contextLength on the ollama embedder', () => {
    const base = {
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'bge-m3',
      dimension: 1024
    };
    expect(
      RecallBootstrapConfigSchema.safeParse({ embedder: { ...base, contextLength: 8192 } }).success
    ).toBe(true);
    expect(
      RecallBootstrapConfigSchema.safeParse({ embedder: { ...base, contextLength: 0 } }).success
    ).toBe(false);
  });

  it('builds FakeEmbedder from { kind: "fake", dimension }', () => {
    const plugin = bootstrap(
      { embedder: { kind: 'fake', dimension: 8 } },
      { store: new InMemoryEmbeddingsStore() }
    );
    expect(plugin.filterOperators).toHaveProperty('embeddingSimilar');
  });

  it('omits embedder when { kind: "off" } (default)', () => {
    const plugin = bootstrap({}, { store: new InMemoryEmbeddingsStore() });
    // filterOperators should be empty when embedder is off
    expect(plugin.filterOperators).toEqual({});
  });

  it('parses HNSW knobs', () => {
    const result = RecallBootstrapConfigSchema.parse({
      embedder: { kind: 'fake', dimension: 8 },
      hnswM: 24,
      hnswEfConstruction: 200
    });
    expect(result.hnswM).toBe(24);
    expect(result.hnswEfConstruction).toBe(200);
  });

  it('uses defaults when config is empty', () => {
    const result = RecallBootstrapConfigSchema.parse({});
    expect(result.embedder).toBeUndefined();
    expect(result.hnswM).toBe(16);
    expect(result.hnswEfConstruction).toBe(64);
  });

  it('treats explicit { kind: "off" } as no embedder', () => {
    const plugin = bootstrap(
      { embedder: { kind: 'off' } },
      { store: new InMemoryEmbeddingsStore() }
    );
    expect(plugin.filterOperators).toEqual({});
  });
});
