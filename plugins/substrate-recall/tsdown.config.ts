import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: {
    index: 'src/index.ts',
    bootstrap: 'src/bootstrap.ts',
    'cluster-worker': 'src/cluster-worker.ts'
  },
  external: [
    '@mnmal-ai/holomap-clusterer',
    '@mnmal-ai/substrate-bootstrap',
    '@mnmal-ai/substrate-compose',
    '@mnmal-ai/substrate-embedder',
    '@mnmal-ai/substrate-types',
    'postgres',
    'node:crypto',
    'node:module',
    'node:worker_threads',
    'zod'
  ]
});
