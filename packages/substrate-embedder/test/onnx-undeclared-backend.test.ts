/**
 * `onnxruntime-node` and `@huggingface/tokenizers` are UNDECLARED — not
 * dependencies, not peers — because the runtime is about 300MB for an opt-in
 * backend. Don't make them optional peers: GitHub Packages' packument omits
 * `peerDependenciesMeta`, so consumers would resolve a required peer and
 * auto-install it.
 *
 * Two things have to hold, and neither is visible in a normal test run because
 * the workspace always HAS both installed as devDependencies:
 *
 *   1. Nothing in `src/` imports them at module scope. A static import would
 *      make `import '@mnmal-ai/substrate-embedder'` throw on a host that never
 *      installed them — moving the failure from the first embed to the first
 *      import, which is the difference between an opt-in backend and a
 *      required one.
 *   2. A host without them gets an error that says what to install.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const SRC_DIR = new URL('../src', import.meta.url).pathname;
const BACKENDS = ['onnxruntime-node', '@huggingface/tokenizers'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the onnx backends stay undeclared and deferred', () => {
  it('are never imported at module scope', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        // `await import('<backend>')` is the sanctioned form — deferred into a
        // function body, so module load never needs the backend.
        if (
          BACKENDS.some((b) => new RegExp(`^\\s*import\\s[^()]*from\\s+['"]${b}['"]`).test(line))
        ) {
          offenders.push(`${file.replace(SRC_DIR, 'src')}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      'a module-scope import of a backend makes it mandatory at import time — ' +
        'defer it with `await import(...)` inside the function that needs it'
    ).toEqual([]);
  });

  it('are not dependencies or peers of this package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const backend of BACKENDS) {
        expect(manifest[field]?.[backend], `${backend} in ${field}`).toBeUndefined();
      }
    }
  });

  it('every supported short name constructs, and an unknown one is refused', async () => {
    const { OnnxEmbedder } = await import('../src/onnx.js');
    for (const model of [
      'all-MiniLM-L6-v2',
      'bge-base-en',
      'bge-base-en-v1.5',
      'bge-small-en',
      'bge-small-en-v1.5',
      'multilingual-e5-large'
    ]) {
      expect(() => new OnnxEmbedder({ model, dimension: 384 })).not.toThrow();
    }
    // A name that is a property of every object must not pass for a model.
    expect(() => new OnnxEmbedder({ model: 'constructor', dimension: 384 })).toThrow(
      /unknown model/
    );
  });

  it('constructing needs no backend at all — only embed() reaches for it', async () => {
    // The distinction the deferred import buys: a host without the backends can
    // still load the module and build the object. Nothing below touches them.
    const { OnnxEmbedder } = await import('../src/onnx.js');
    const embedder = new OnnxEmbedder({ model: 'bge-small-en-v1.5', dimension: 384 });
    expect(embedder.modelId).toBe('bge-small-en-v1.5:384');
  });

  it('turns an unresolvable backend into an actionable EmbedError, not MODULE_NOT_FOUND', async () => {
    vi.resetModules();
    // Simulated rather than uninstalled: the workspace has the backends as
    // devDependencies, so failing the resolution is the only way to walk the
    // path a consumer without them would actually hit.
    vi.doMock('onnxruntime-node', () => {
      throw new Error("Cannot find module 'onnxruntime-node'");
    });
    const { OnnxEmbedder } = await import('../src/onnx.js');
    const { EmbedError } = await import('../src/types.js');
    const embedder = new OnnxEmbedder({ model: 'bge-small-en-v1.5', dimension: 384 });

    await expect(embedder.embed('hello')).rejects.toThrow(EmbedError);
    await expect(embedder.embed('hello')).rejects.toThrow(
      /pnpm add onnxruntime-node @huggingface\/tokenizers/
    );
    await expect(embedder.embed('hello')).rejects.toMatchObject({ code: 'unavailable' });

    vi.doUnmock('onnxruntime-node');
    vi.resetModules();
  });
});
