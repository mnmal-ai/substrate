import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: { index: 'src/index.ts', fake: 'src/fake.ts', ollama: 'src/ollama.ts' },
  // `fastembed` is listed explicitly because it is an OPTIONAL PEER and also a
  // devDependency (so this package's own tests can exercise it). tsdown
  // externalises declared dependencies and INLINES everything else — a
  // devDependency-only specifier would therefore be bundled in, which for an
  // optional peer means shipping the 520MB backend to every consumer inside
  // the tarball while the manifest says they can opt out. See
  // apps/substrate/test/plugin-runtime-deps.test.ts for the same trap.
  external: ['@mnmal-ai/substrate-types', 'fastembed', 'node:crypto', 'node:fs', 'node:module']
});
