/**
 * `fastembed` is UNDECLARED — not a dependency, not a peer — because it drags
 * in onnxruntime-node for an opt-in backend. Don't make it an optional peer:
 * GitHub Packages' packument omits `peerDependenciesMeta`, so consumers would
 * resolve a required peer and auto-install it.
 *
 * Two things have to hold, and neither is visible in a normal test run because
 * the workspace always HAS fastembed installed as a devDependency:
 *
 *   1. Nothing in `src/` imports it at module scope. A static import would make
 *      `import '@mnmal-ai/substrate-embedder'` throw on a host that never installed
 *      it — moving the failure from the first embed to the first import, which
 *      is the difference between an opt-in backend and a required one.
 *   2. The short-name → fastembed model-id strings are spelled out locally
 *      (that is what lets rule 1 hold), so they can drift from the real enum
 *      silently. This pins them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmbeddingModel, ExecutionProvider } from 'fastembed';
import { describe, expect, it, vi } from 'vitest';

const SRC_DIR = new URL('../src', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('fastembed stays an undeclared, deferred backend', () => {
  it('is never imported at module scope', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        // `await import('fastembed')` is the sanctioned form — deferred into a
        // function body, so module load never needs the peer.
        if (/^\s*import\s[^()]*from\s+['"]fastembed['"]/.test(line)) {
          offenders.push(`${file.replace(SRC_DIR, 'src')}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      'a module-scope import of fastembed makes the backend mandatory at import time — ' +
        'defer it with `await import(...)` inside the function that needs it'
    ).toEqual([]);
  });

  it('the locally spelled-out model ids match fastembed 2.1.1', async () => {
    // Read the map through the module's own behaviour rather than exporting it
    // just for the test: every supported short name must construct, and the
    // constructor is what rejects an unknown one.
    const { OnnxEmbedder } = await import('../src/onnx.js');
    const supported: Record<string, EmbeddingModel> = {
      'all-MiniLM-L6-v2': EmbeddingModel.AllMiniLML6V2,
      'bge-base-en': EmbeddingModel.BGEBaseEN,
      'bge-base-en-v1.5': EmbeddingModel.BGEBaseENV15,
      'bge-small-en': EmbeddingModel.BGESmallEN,
      'bge-small-en-v1.5': EmbeddingModel.BGESmallENV15,
      'multilingual-e5-large': EmbeddingModel.MLE5Large
    };
    for (const name of Object.keys(supported)) {
      expect(() => new OnnxEmbedder({ model: name, dimension: 384 })).not.toThrow();
    }
    // The values are what the deferred import passes to FlagEmbedding.init, so
    // a rename upstream has to fail here rather than at first embed.
    const src = readFileSync(join(SRC_DIR, 'onnx.ts'), 'utf8');
    for (const [shortName, modelId] of Object.entries(supported)) {
      expect(src, `MODEL_MAP is missing the fastembed id for '${shortName}'`).toContain(
        `'${modelId}'`
      );
    }
    expect(src, 'the CPU execution provider literal drifted').toContain(
      `'${ExecutionProvider.CPU}'`
    );
  });

  it('constructing needs no backend at all — only embed() reaches for it', async () => {
    // The distinction the deferred import buys: a host without fastembed can still
    // load the module and build the object. Nothing below can touch fastembed.
    const { OnnxEmbedder } = await import('../src/onnx.js');
    const embedder = new OnnxEmbedder({ model: 'bge-small-en-v1.5', dimension: 384 });
    expect(embedder.modelId).toBe('bge-small-en-v1.5:384');
  });

  it('turns an unresolvable backend into an actionable EmbedError, not MODULE_NOT_FOUND', async () => {
    vi.resetModules();
    // Simulated rather than uninstalled: the workspace has fastembed as a
    // devDependency, so failing the resolution is the only way to walk the path
    // a consumer without it would actually hit.
    vi.doMock('fastembed', () => {
      throw new Error("Cannot find module 'fastembed'");
    });
    const { OnnxEmbedder } = await import('../src/onnx.js');
    const { EmbedError } = await import('../src/types.js');
    const embedder = new OnnxEmbedder({ model: 'bge-small-en-v1.5', dimension: 384 });

    await expect(embedder.embed('hello')).rejects.toThrow(EmbedError);
    await expect(embedder.embed('hello')).rejects.toThrow(/pnpm add fastembed/);
    await expect(embedder.embed('hello')).rejects.toMatchObject({ code: 'unavailable' });

    vi.doUnmock('fastembed');
    vi.resetModules();
  });
});
