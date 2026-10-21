import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { l2normalize } from '../src/l2normalize.js';
import type { ClusterSpawn, ClusterWorkerRequest } from '../src/run-clusterer.js';
import { runClusterer } from '../src/run-clusterer.js';

/**
 * Spawns the worker from `src/cluster-worker.ts` with the strip-types loader,
 * as cluster-worker-isolation.test.ts does. `runClusterer`'s default spawn
 * resolves `./cluster-worker.js`, which exists only in a built `dist/`. The
 * real wasm clusterer still runs in a real worker thread.
 */
const WORKER_SRC = new URL('../src/cluster-worker.ts', import.meta.url).pathname;
const LOADER = new URL('./ts-extension-loader.mjs', import.meta.url).pathname;

interface WorkerReply {
  ok: boolean;
  assignments?: Int32Array;
  message?: string;
}

const testSpawn: ClusterSpawn = (payload: ClusterWorkerRequest) =>
  new Promise<Int32Array>((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      execArgv: ['--experimental-strip-types', '--import', LOADER]
    });
    worker.on('message', (reply: WorkerReply) => {
      void worker.terminate();
      if (reply.ok && reply.assignments !== undefined) {
        resolve(reply.assignments);
      } else {
        reject(new Error(reply.message ?? 'cluster worker failed without a message'));
      }
    });
    worker.on('error', (err) => {
      void worker.terminate();
      reject(err);
    });
    worker.postMessage(payload);
  });

/**
 * Corpus regression gate for the wasm × normalised cell of a 2×2, regime
 * (raw | normalised) × backend (wasm | native). The nearest published figure
 * for this cell is 36 clusters / 27.0% noise; the other cells are different
 * numbers:
 *
 *   regime      | wasm         | native
 *   raw         | 37 / 29.6%   | 36 / 30.0%
 *   normalised  | 36 / 27.0%   | 34 / 27.2%   <- native, NOT ours
 *
 * A BAND, not a point, to absorb regime, cross-backend and cross-host drift.
 * It is a coarse "has something moved a LOT" check (wrong corpus, broken
 * clusterer, parameter typo): all four cells land inside it, so it does NOT
 * discriminate raw from normalised. Tightening it would produce false
 * failures; the regime is pinned by 'discriminates the normalised regime
 * from raw' below instead.
 *
 * Do not switch to the native backend: it gives different results on
 * different CPUs from the same build, while wasm reproduces across hosts.
 *
 * Env-gated on HOLOMAP_CLUSTERER_FIXTURE because the corpus (9.4 MB) lives
 * outside this repo. Unset, this file skips.
 *
 *   HOLOMAP_CLUSTERER_FIXTURE=/path/to/fixtures/2026-06-05-claude-corpus-799.tsv \
 *     pnpm --filter @mnmal-ai/substrate-recall test corpus-regression
 */

const FIXTURE = process.env.HOLOMAP_CLUSTERER_FIXTURE;

/**
 * The corpus is unversioned and external; if it is regenerated every figure
 * moves. Fail loudly on mismatch rather than silently measure a different
 * corpus.
 */
const FIXTURE_SHA256 = 'd65077b8c3f62fa2a873507cacc8a7afb8f46ad9ad7e7b959bc23591f9620c4b';

const FIXTURE_ROWS = 723;
const FIXTURE_DIMS = 1024;

/** wasm × normalised. Band around the nearest published figure for this cell. */
const CLUSTER_BAND = { min: 33, max: 39 };
const NOISE_RATE_BAND = { min: 0.24, max: 0.31 };

const PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 };

/**
 * Loader mirroring holomap's `npm/test/fixture.ts`. The synthetic-row
 * exclusion is load-bearing: those 76 near-duplicate perf fixtures form the
 * densest regions in the corpus and dominate a naive clustering. The
 * row-count assertion catches the filter drifting.
 *
 * Unlike upstream, the sha256 is not asserted inline: it has its own `it()`,
 * so a changed corpus and a drifted filter fail separately.
 */
function loadFixture(path: string): Float32Array[] {
  const out: Float32Array[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const text = cols[4]!;
    if (text.startsWith('Seed session ') || text.startsWith('perf-seed-memory-')) continue;

    const raw = cols[5]!.trim().replace(/^\[|\]$/g, '');
    const parts = raw.split(',');
    const v = new Float32Array(parts.length);
    // Float32Array assignment does the f64 -> f32 rounding.
    for (let i = 0; i < parts.length; i++) v[i] = Number(parts[i]);
    out.push(v);
  }
  return out;
}

describe.skipIf(FIXTURE === undefined)('corpus regression — wasm × normalised', () => {
  it('is measuring the corpus every recorded figure was measured against', () => {
    const bytes = readFileSync(FIXTURE as string);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(
      digest,
      'the reference corpus has changed — every figure in the 2x2 moves with it; ' +
        're-measure before touching the bands below'
    ).toBe(FIXTURE_SHA256);
  });

  it('loads 723 rows after the synthetic-row filter', () => {
    const vectors = loadFixture(FIXTURE as string);
    expect(
      vectors.length,
      'the synthetic-row filter is out of sync with the upstream loader, or this is a different export'
    ).toBe(FIXTURE_ROWS);
    expect(vectors[0]?.length).toBe(FIXTURE_DIMS);
  });

  it('produces a cluster count and noise rate inside the wasm x normalised band', async () => {
    const vectors = loadFixture(FIXTURE as string);
    // The regime, applied by the SAME function the request path ships.
    const normalised = l2normalize(vectors);
    const assignments = await runClusterer(normalised, PARAMS, { spawn: testSpawn });

    const clusters = new Set(assignments.filter((l) => l >= 0)).size;
    const noise = assignments.filter((l) => l === -1).length;
    const noiseRate = noise / assignments.length;

    // Printed so a run that passes still leaves the measurement on the
    // record — a band that is never seen is a band nobody can tighten.
    process.stdout.write(
      `corpus regression [wasm x normalised]: ${clusters} clusters, ` +
        `${(noiseRate * 100).toFixed(1)}% noise (${noise}/${assignments.length})\n`
    );

    expect(clusters).toBeGreaterThanOrEqual(CLUSTER_BAND.min);
    expect(clusters).toBeLessThanOrEqual(CLUSTER_BAND.max);
    expect(noiseRate).toBeGreaterThanOrEqual(NOISE_RATE_BAND.min);
    expect(noiseRate).toBeLessThanOrEqual(NOISE_RATE_BAND.max);
  }, 300_000);

  it('is deterministic within the regime — same input, same seed, same assignments', async () => {
    const vectors = loadFixture(FIXTURE as string).slice(0, 200);
    const normalised = l2normalize(vectors);
    const first = await runClusterer(normalised, PARAMS, { spawn: testSpawn });
    const second = await runClusterer(l2normalize(vectors), PARAMS, { spawn: testSpawn });
    expect(second).toEqual(first);
  }, 300_000);

  /**
   * Pins the regime the band cannot: cluster the same corpus with the same
   * params, seed and backend, with and without `l2normalize`, and assert the
   * results differ.
   *
   * Normalising before a pipeline that normalises internally is a no-op in
   * exact arithmetic but not in float32: the rounding alone moves cluster
   * identity. Identical results would mean either `l2normalize` stopped being
   * applied or the clusterer stopped being sensitive to input scaling.
   *
   * Clusters the full corpus twice; acceptable because the file is env-gated.
   */
  it('discriminates the normalised regime from raw — same corpus, same params, different regime, different result', async () => {
    const vectors = loadFixture(FIXTURE as string);
    const normalisedAssignments = await runClusterer(l2normalize(vectors), PARAMS, {
      spawn: testSpawn
    });
    const rawAssignments = await runClusterer(vectors, PARAMS, { spawn: testSpawn });

    const normalisedClusters = new Set(normalisedAssignments.filter((l) => l >= 0)).size;
    const normalisedNoise = normalisedAssignments.filter((l) => l === -1).length;
    const rawClusters = new Set(rawAssignments.filter((l) => l >= 0)).size;
    const rawNoise = rawAssignments.filter((l) => l === -1).length;

    process.stdout.write(
      `corpus regression [regime discrimination]: normalised = ${normalisedClusters} clusters, ` +
        `${((normalisedNoise / normalisedAssignments.length) * 100).toFixed(1)}% noise ` +
        `(${normalisedNoise}/${normalisedAssignments.length}); raw = ${rawClusters} clusters, ` +
        `${((rawNoise / rawAssignments.length) * 100).toFixed(1)}% noise (${rawNoise}/${rawAssignments.length})\n`
    );

    expect(
      rawAssignments,
      'raw and normalised produced IDENTICAL assignments — either l2normalize stopped being ' +
        'applied on this path, or the clusterer stopped being sensitive to input scaling; ' +
        'both are regressions this test exists to catch'
    ).not.toEqual(normalisedAssignments);
  }, 300_000);
});

/**
 * Upstream-coupling checks. `l2normalize` replicates holomap's
 * `npm/test/fixture.ts` byte for byte; the vendored snapshot in
 * `test/fixtures/` pins the agreed upstream, splitting drift into two reds
 * with opposite meanings:
 *
 *   ours vs snapshot red    WE moved (or the snapshot was refreshed without
 *                           re-measuring) — re-measure the baseline before
 *                           accepting.
 *   live vs snapshot red    UPSTREAM moved — refresh the snapshot per its
 *                           header procedure, which will turn the first red
 *                           until the baseline is re-measured. Never refresh
 *                           both in one unmeasured motion.
 */
const SNAPSHOT_SRC = new URL('./fixtures/holomap-l2normalize.snapshot.ts', import.meta.url);
const UPSTREAM_SRC = process.env.HOLOMAP_CLUSTERER_SRC;

const bodyOf = (source: string): string => {
  const start = source.indexOf('export function l2normalize');
  expect(start, 'could not find l2normalize in the source').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source
    .slice(open, i + 1)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
};

describe('l2normalize upstream coupling', () => {
  it('our replica matches the vendored snapshot — runs everywhere, including CI', () => {
    const ours = readFileSync(new URL('../src/l2normalize.ts', import.meta.url), 'utf8');
    const snapshot = readFileSync(SNAPSHOT_SRC, 'utf8');
    expect(
      bodyOf(ours),
      'l2normalize has drifted from the vendored upstream snapshot — at 5.7e-10 sensitivity ' +
        '"equivalent" is not equivalent; re-measure the baseline before accepting this'
    ).toBe(bodyOf(snapshot));
  });
});

describe.skipIf(UPSTREAM_SRC === undefined || !existsSync(UPSTREAM_SRC))(
  'l2normalize live upstream coupling',
  () => {
    it('the live checkout matches the vendored snapshot — red means upstream moved', () => {
      const live = readFileSync(UPSTREAM_SRC as string, 'utf8');
      const snapshot = readFileSync(SNAPSHOT_SRC, 'utf8');
      expect(
        bodyOf(live),
        'upstream l2normalize moved past the vendored snapshot — refresh the snapshot per ' +
          'its header procedure, then expect ours-vs-snapshot to go red until the Task 12 ' +
          'baseline is re-measured'
      ).toBe(bodyOf(snapshot));
    });

    it('our replica matches upstream byte for byte', () => {
      const ours = readFileSync(new URL('../src/l2normalize.ts', import.meta.url), 'utf8');
      const theirs = readFileSync(UPSTREAM_SRC as string, 'utf8');
      expect(
        bodyOf(ours),
        'l2normalize has drifted from the upstream reference — at 5.7e-10 sensitivity ' +
          '"equivalent" is not equivalent; re-measure the baseline before accepting this'
      ).toBe(bodyOf(theirs));
    });
  }
);
