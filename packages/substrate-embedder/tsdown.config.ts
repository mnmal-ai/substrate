import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: { index: 'src/index.ts', fake: 'src/fake.ts', ollama: 'src/ollama.ts' },
  // The onnx backends are listed explicitly because they are undeclared and
  // also devDependencies (so this package's own tests can exercise them).
  // tsdown externalises declared dependencies and INLINES everything else — a
  // devDependency-only specifier would therefore be bundled in, which means
  // shipping a 300MB runtime to every consumer inside the tarball while the
  // manifest says they can opt out. See
  // apps/substrate/test/plugin-runtime-deps.test.ts for the same trap.
  external: [
    '@mnmal-ai/substrate-types',
    'onnxruntime-node',
    '@huggingface/tokenizers',
    'node:crypto',
    'node:fs',
    'node:module',
    'node:path',
    'node:stream',
    'node:stream/promises'
  ]
});
