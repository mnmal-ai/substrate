import { defineBinTsdown, defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

// The published package is one bundle: every @mnmal-ai/substrate-* workspace
// package is inlined, and code shared between entries lands in shared chunks,
// so the binary, the built-in plugins and every subpath share one copy of each
// class (one module realm). Third-party runtime deps stay external.
const EXTERNAL = [
  '@fastify/compress',
  '@fastify/cors',
  '@fastify/websocket',
  '@mnmal-ai/holomap-clusterer',
  '@modelcontextprotocol/sdk',
  '@preact/signals-core',
  'fastembed',
  'fastify',
  'msgpackr',
  'postgres',
  'semver',
  'ws',
  'zod'
];

// Public subpaths, with bundled declarations.
const PUBLIC = {
  sdk: 'src/exports/sdk.ts',
  client: 'src/exports/client.ts',
  pack: 'src/exports/pack.ts',
  testing: 'src/exports/testing.ts',
  recall: 'src/exports/recall.ts',
  proposals: 'src/exports/proposals.ts'
};

const js = defineBinTsdown({
  // Flat: recall spawns `./cluster-worker.js` relative to the chunk that holds
  // the spawn, and every chunk lands in dist/.
  entry: {
    ...PUBLIC,
    substrate: 'src/bin/substrate.ts',
    'substrate-admin': 'src/bin/admin.ts',
    'recall-bootstrap': 'src/exports/recall-bootstrap.ts',
    'proposals-bootstrap': 'src/exports/proposals-bootstrap.ts',
    'cluster-worker': 'src/exports/cluster-worker.ts'
  },
  banner: {
    js: "import { createRequire as __binCreateRequire } from 'node:module'; const require = __binCreateRequire(import.meta.url);"
  },
  neverBundle: EXTERNAL,
  alwaysBundle: [/^@mnmal-ai\/substrate-/, /^@inquirer\//]
});

// Both builds resolve workspace packages to their sources (tsconfig.bundle.json),
// so the bundle never reads another package's dist.
js.tsconfig = '../../tsconfig.bundle.json';

const dts = {
  ...defineLibTsdown({ entry: PUBLIC, external: EXTERNAL }),
  clean: false,
  tsconfig: '../../tsconfig.bundle.json',
  dts: { resolve: [/^@mnmal-ai\/substrate-/], emitDtsOnly: true }
};

export default [js, dts];
