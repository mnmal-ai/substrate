/**
 * Structured-config bootstrap for `@mnmal-ai/substrate-recall`.
 *
 * Substrate-tier variant: merges the operator JSON config with a typed bag of
 * host-built deps (`RecallHostDeps`) into `createRecallPlugin`'s input.
 *
 * What's operator-overridable (via JSON config):
 *   - `embedder`           discriminated union: off | fake | ollama | onnx
 *     - `{ kind: 'off' }`  (default) — no embedder; filter operators, MCP
 *                          tools, and route handlers that need it are omitted
 *     - `{ kind: 'fake', dimension }` — deterministic hash-based embedder for
 *                          tests and local dev
 *     - `{ kind: 'ollama', baseUrl, model, dimension, timeoutMs?, contextLength? }`
 *                          — Ollama HTTP embedder; `contextLength` defaults to
 *                          the model's, read from Ollama
 *     - `{ kind: 'onnx', model, dimension, cacheDir?, maxLength? }` — local
 *                          ONNX embedder
 *   - `hnswM`               HNSW index build param `m` (default 16)
 *   - `hnswEfConstruction`  HNSW index build param `ef_construction` (default 64)
 *   - `salience`, `expansion`, `crystallise` — see the schemas below
 *
 * Vector dimension is derived from the constructed embedder's `dimension` so
 * fresh installs match what the embedder will write. Falls back to 768 when
 * no embedder is built.
 *
 * Invoked by the binary's plugin-dir loader when discovering plugins under
 * `SUBSTRATE_PLUGIN_DIR`.
 */

import { defineBootstrap } from '@mnmal-ai/substrate-bootstrap';
import {
  type Embedder,
  OllamaEmbedder,
  OnnxEmbedder,
  type OnnxEmbedderOptions
} from '@mnmal-ai/substrate-embedder';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Dataset, EdgesStore } from '@mnmal-ai/substrate-types';
import { z } from 'zod';
import type { ClusterStore, MemberRef } from './cluster-store.js';
import type { EmbedStats } from './embed-stats.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import type { LexicalStore } from './lexical-store.js';
import { createRecallPlugin } from './plugin.js';
import type { ReadPolicyCheck, WritePolicyCheck } from './recall-route.js';

const EmbedderSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('off')
    })
    .strict(),
  z
    .object({
      kind: z.literal('fake'),
      dimension: z.number().int().positive().default(8)
    })
    .strict(),
  z
    .object({
      kind: z.literal('ollama'),
      baseUrl: z.url(),
      model: z.string().min(1),
      dimension: z.number().int().positive(),
      timeoutMs: z.number().int().positive().default(120000),
      contextLength: z.number().int().positive().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('onnx'),
      model: z.string().min(1),
      dimension: z.number().int().positive(),
      cacheDir: z.string().min(1).optional(),
      maxLength: z.number().int().positive().default(512)
    })
    .strict()
]);

const SalienceSchema = z
  .object({
    /**
     * Blend weight. `0` (default) leaves ranking
     * unchanged; the boost-on-recall still fires so the signal accumulates
     * passively, ready for opt-in once an operator has data to evaluate.
     */
    weight: z.number().min(0).default(0),
    /** Half-life for boost-time exponential decay. Default 168h (7 days). */
    halfLifeHours: z.number().positive().default(168),
    /**
     * Activation-spreading damping. Each opt-in
     * crossRef neighbour of a boosted row gets `spreadDamping × bump`.
     * Default 0.3 keeps the spread modest; 0 disables spreading even if
     * `spread: true` is declared on fields.
     */
    spreadDamping: z.number().min(0).max(1).default(0.3)
  })
  .strict();

const ExpansionSchema = z
  .object({
    /**
     * Plugin-level kill-switch. When false, the recall route
     * ignores per-request `expand:true` and returns the knn-only result.
     * Per-request `expand:false` (the default) always wins regardless.
     */
    enabled: z.boolean().default(true),
    /**
     * Maximum neighbours pushed per seed row, applied PER DIRECTION
     * (forward + backward each track separately). Effective max across both
     * directions is up to 2× this value when backward is enabled.
     */
    maxNeighboursPerSeed: z.number().int().positive().default(8),
    /** Maximum total neighbours per request (whole-batch cap). */
    maxTotalNeighbours: z.number().int().positive().default(50)
  })
  .strict();

const CrystalliseSchema = z
  .object({
    /** UMAP output dimensionality. 0 skips reduction (holomap convention). */
    nComponents: z.number().int().nonnegative().default(10),
    nNeighbors: z.number().int().positive().default(15),
    /**
     * HDBSCAN floor, and the live-member floor below which a cluster retires.
     * One knob for both: a cluster too small for the clusterer to have
     * proposed is too small to keep claiming rows.
     */
    minClusterSize: z.number().int().positive().default(5),
    /** Fixed so a re-run is reproducible. Changing it changes assignments. */
    seed: z.number().int().default(42),
    /**
     * Cosine floor for accretion. A POLICY knob — tune it against this
     * deployment's own measured baseline, not against a figure from another
     * corpus or another backend.
     */
    accretionThreshold: z.number().min(0).max(1).default(0.6)
  })
  .strict();

export const RecallBootstrapConfigSchema = z
  .object({
    embedder: EmbedderSchema.optional(),
    queryEmbedTimeoutMs: z.number().int().positive().default(30_000),
    writeEmbedTimeoutMs: z.number().int().positive().default(30_000),
    hnswM: z.number().int().positive().default(16),
    hnswEfConstruction: z.number().int().positive().default(64),
    salience: SalienceSchema.default({ weight: 0, halfLifeHours: 168, spreadDamping: 0.3 }),
    expansion: ExpansionSchema.default({
      enabled: true,
      maxNeighboursPerSeed: 8,
      maxTotalNeighbours: 50
    }),
    crystallise: CrystalliseSchema.default({
      nComponents: 10,
      nNeighbors: 15,
      minClusterSize: 5,
      seed: 42,
      accretionThreshold: 0.6
    })
  })
  .strict();

export type RecallBootstrapConfig = z.infer<typeof RecallBootstrapConfigSchema>;
export type EmbedderConfig = z.infer<typeof EmbedderSchema>;

export interface RecallHostDeps {
  store: EmbeddingsStore;
  /**
   * Store for the lexical arm. Absent → types declaring `lexical.source`
   * contribute nothing, the same posture an absent embedder has for the dense
   * arm.
   */
  lexicalStore?: LexicalStore;
  stats?: EmbedStats;
  /**
   * Optional dataset resolver. When supplied, the `embed.source` functions
   * of every embedded type receive an `EmbedSourceContext` whose `read(ns,
   * type, { id })` is backed by this lookup. Lets source functions inline
   * related-entity context via crossRef.
   *
   * Late-bound by the binary: the dataset registry exists only after
   * `compose()`. Returning `null` for unknown namespaces is fine — source
   * functions check + skip. When omitted, source functions receive
   * `undefined` for ctx.
   */
  resolveDataset?: (namespace: string) => Dataset | null;
  /**
   * Optional EdgesStore. Used by activation spreading to resolve backward
   * (inbound) edges. Forward spreading works without
   * it — forward only reads row body field values. When omitted in a pg
   * deployment, backward spreading silently no-ops.
   */
  edges?: EdgesStore | null;
  /**
   * Read-policy probe. The binary wires this to `engine.evaluateReadPolicy`
   * via a late-bound holder (the engine exists only after `compose()`). When
   * omitted, recall stays open.
   */
  checkReadPolicy?: ReadPolicyCheck;
  /**
   * Write-policy probe. The binary wires this to `engine.evaluateWritePolicy`
   * through the same late-bound holder.
   *
   * Must be threaded here: this factory is how a runtime under
   * `SUBSTRATE_PLUGIN_DIR` builds the plugin. Omitting it fails closed, so the
   * symptom is silent loss of reinforcement rather than an error.
   */
  checkWritePolicy?: WritePolicyCheck;
  /**
   * Cluster persistence. The binary builds a `PgClusterStore` on a pg-backed
   * store and an `InMemoryClusterStore` otherwise. Omitted = crystallisation
   * composes as unavailable.
   */
  clusters?: ClusterStore;
  /** Probe backing the membership decay sweep; see RecallPluginConfig. */
  rowsMissing?: (refs: readonly MemberRef[]) => Promise<Set<string>>;
}

function buildEmbedder(config: EmbedderConfig): Embedder | null {
  if (config.kind === 'off') return null;
  if (config.kind === 'fake') {
    return new FakeEmbedder({ dimension: config.dimension });
  }
  if (config.kind === 'onnx') {
    const opts: OnnxEmbedderOptions = {
      model: config.model,
      dimension: config.dimension,
      maxLength: config.maxLength
    };
    if (config.cacheDir !== undefined) opts.cacheDir = config.cacheDir;
    return new OnnxEmbedder(opts);
  }
  return new OllamaEmbedder({
    baseUrl: config.baseUrl,
    model: config.model,
    dimension: config.dimension,
    timeoutMs: config.timeoutMs,
    ...(config.contextLength !== undefined ? { contextLength: config.contextLength } : {})
  });
}

const DEFAULT_DIMENSION_NO_EMBEDDER = 768;

export const bootstrap = defineBootstrap.kernel<RecallBootstrapConfig, RecallHostDeps>({
  schema: RecallBootstrapConfigSchema,
  build: (config, deps) => {
    const embedder = config.embedder !== undefined ? buildEmbedder(config.embedder) : null;
    return createRecallPlugin({
      ...(embedder !== null ? { embedder } : {}),
      queryEmbedTimeoutMs: config.queryEmbedTimeoutMs,
      writeEmbedTimeoutMs: config.writeEmbedTimeoutMs,
      ...(deps.lexicalStore !== undefined ? { lexicalStore: deps.lexicalStore } : {}),
      store: deps.store,
      ...(deps.stats !== undefined ? { stats: deps.stats } : {}),
      ...(deps.resolveDataset !== undefined ? { resolveDataset: deps.resolveDataset } : {}),
      ...(deps.edges !== undefined ? { edges: deps.edges } : {}),
      ...(deps.checkReadPolicy !== undefined ? { checkReadPolicy: deps.checkReadPolicy } : {}),
      ...(deps.checkWritePolicy !== undefined ? { checkWritePolicy: deps.checkWritePolicy } : {}),
      ...(deps.clusters !== undefined ? { clusters: deps.clusters } : {}),
      ...(deps.rowsMissing !== undefined ? { rowsMissing: deps.rowsMissing } : {}),
      migration: {
        dimension: embedder?.dimension ?? DEFAULT_DIMENSION_NO_EMBEDDER,
        hnswM: config.hnswM,
        hnswEfConstruction: config.hnswEfConstruction
      },
      salience: config.salience,
      expansion: config.expansion,
      crystallise: config.crystallise
    });
  }
});

export default bootstrap;
