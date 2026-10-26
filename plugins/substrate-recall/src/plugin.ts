/**
 * createRecallPlugin — KernelPlugin factory for substrate-recall.
 *
 * Composes all five substrate slots:
 *   - migrations:        embeddings, salience, HNSW, cluster and lexical tables
 *   - filterOperators:   embeddingSimilar (omitted when no embedder)
 *   - kernelRoutes:      POST /substrate/v1/recall, GET /substrate/v1/embed-stats,
 *                        POST /substrate/v1/embeddings/fetch, POST /substrate/v1/salience/boost,
 *                        POST /substrate/v1/crystallise, POST /substrate/v1/embed/reindex,
 *                        POST /substrate/v1/lexical/reindex
 *   - mcpTools:          recall
 *   - kernelNamespace: recall/* frame surface
 *
 * Usage:
 *   const plugin = createRecallPlugin({ embedder, store });
 *   // wire into the binary's substrate plugin loader
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type {
  Dataset,
  EdgesStore,
  EmbedSourceContext,
  FieldDef,
  KernelPlugin,
  PostWriteHook
} from '@mnmal-ai/substrate-types';
import { alignVectorDimensions } from './align-dimension.js';
import type { ClusterStore, MemberRef } from './cluster-store.js';
import { type CrystalliseConfig, DEFAULT_CRYSTALLISE_CONFIG } from './crystallise-core.js';
import { createCrystalliseGuard } from './crystallise-guard.js';
import { crystalliseRouteHandler } from './crystallise-route.js';
import { makeEmbedPostWrite, makeReembed } from './embed-and-store.js';
import { runEmbedBackfill } from './embed-backfill.js';
import { EmbedSourceRegistry } from './embed-source-registry.js';
import { createEmbedStats, type EmbedStats } from './embed-stats.js';
import { embedStatsRouteHandler } from './embed-stats-route.js';
import { embeddingsFetchRouteHandler } from './embeddings-fetch-route.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import { makeExpansionResolver } from './expansion-resolver.js';
import { embeddingSimilarOperator } from './filter-operator.js';
import { buildRecallFrameSurface } from './frame-surface.js';
import { makeLexicalClassify, makeLexicalPostWrite, makeLexicalReindex } from './lexical-index.js';
import { lexicalReindexRouteHandler } from './lexical-reindex-route.js';
import { LexicalSourceRegistry } from './lexical-source-registry.js';
import type { LexicalStore } from './lexical-store.js';
import { recallMcpTool } from './mcp-tool.js';
import {
  type EmbeddingsMigrationOptions,
  embeddingsMigration
} from './migrations/0001_embeddings.js';
import { recallClustersMigration } from './migrations/0002_recall_clusters.js';
import { type LexicalMigrationOptions, lexicalMigration } from './migrations/0003_lexical.js';
import {
  type ReadPolicyCheck,
  recallRouteHandler,
  type SalienceConfig,
  type WritePolicyCheck
} from './recall-route.js';
import { reindexRouteHandler } from './reindex-route.js';
import type { ClusterRunParams } from './run-clusterer.js';
import { salienceBoostRouteHandler } from './salience-boost-route.js';
import { makeSpreadResolver, SpreadEdgeRegistry } from './spread-resolver.js';

// The centroid column must match `embeddings.embedding` — the same
// `cfg.migration.dimension` drives both (see embeddingsMigration below).
const DEFAULT_CLUSTER_DIMENSION = 768;

const DEFAULT_EMBED_BACKFILL_INTERVAL_MS = 60_000;
/** Rows per embedded type per pass, so one pass stays a few seconds of embed work. */
const EMBED_BACKFILL_PER_TYPE = 50;
export const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 30_000;
export const DEFAULT_WRITE_EMBED_TIMEOUT_MS = 30_000;

/** `embedder` with `timeoutMs` applied to every call that does not set its own. */
function withEmbedTimeout(embedder: Embedder, timeoutMs: number): Embedder {
  return {
    modelId: embedder.modelId,
    dimension: embedder.dimension,
    embed: (text, opts) =>
      embedder.embed(text, { ...opts, timeoutMs: opts?.timeoutMs ?? timeoutMs })
  };
}

export interface RecallPluginConfig {
  embedder?: Embedder;
  /**
   * Timeout for embedding a recall or `embeddingSimilar` query, in ms.
   * Reindex embeds keep the embedder's own timeout. Default 30000.
   */
  queryEmbedTimeoutMs?: number;
  /**
   * Timeout for the embed that follows a write, in ms. The engine awaits
   * after-commit work before it replies, so this bounds how long an already
   * committed write can be held by a slow embedder. A timed-out embed keeps
   * the row's previous vector until its next write or a reindex. Default 30000.
   */
  writeEmbedTimeoutMs?: number;
  /**
   * How often to re-embed rows whose write-path embed failed or timed out (their
   * vector is missing or older than the row). 0 disables. Default 60000.
   */
  embedBackfillIntervalMs?: number;
  store: EmbeddingsStore;
  /**
   * Store for the lexical arm. Absent → types declaring `lexical.source`
   * contribute nothing, the same way an absent `embedder` disables the dense
   * arm. Independent of `embedder` in both directions on purpose: lexical
   * recall needs no vectors.
   */
  lexicalStore?: LexicalStore;
  /**
   * Build params for the lexical table (text search configuration). The
   * migration applies whether or not `lexicalStore` is wired — same posture as
   * the embeddings migration under an absent embedder: the schema is present
   * so an operator turning the arm on later needs no separate migration pass.
   */
  lexicalMigration?: LexicalMigrationOptions;
  /** Optional pre-built stats counter; a fresh one is created when omitted. */
  stats?: EmbedStats;
  /**
   * Migration build params (vector dimension + HNSW m / ef_construction).
   * When omitted, the migration falls back to its built-in defaults
   * (dim 768; m 16 and ef_construction 64, the pgvector defaults). When `embedder` is supplied, the caller is expected
   * to set `dimension` to `embedder.dimension` so fresh installs match.
   */
  migration?: EmbeddingsMigrationOptions;
  /**
   * Optional dataset resolver. When supplied, each `embed.source(row, ctx)`
   * receives an `EmbedSourceContext` whose `read` is backed by this lookup,
   * letting source functions inline related-entity context via crossRef.
   * When omitted, source receives `undefined` for ctx.
   */
  resolveDataset?: (namespace: string) => Dataset | null;
  /**
   * Salience blend config. When omitted, the route falls back to
   * `DEFAULT_SALIENCE_CONFIG` (weight=0, 7-day half-life).
   */
  salience?: SalienceConfig;
  /**
   * EdgesStore used by activation spreading to resolve backward (inbound)
   * edges. When omitted, the spread path only walks forward (X → row X
   * references).
   */
  edges?: EdgesStore | null;
  /**
   * Bounds on crossRef walking when `input.expand:true`. When omitted, falls
   * back to plugin defaults.
   */
  expansion?: {
    enabled: boolean;
    maxNeighboursPerSeed: number;
    maxTotalNeighbours: number;
  };
  /**
   * Read-policy probe. Hosts wire this to `engine.evaluateReadPolicy`
   * (late-bound — the engine exists only after compose) so the recall
   * surfaces honour the same composed policies that gate `engine.query`.
   * When omitted, recall stays open.
   */
  checkReadPolicy?: ReadPolicyCheck;
  /**
   * Write-policy probe for the mutating surfaces. Hosts wire this to
   * `engine.evaluateWritePolicy`. Unwired → those surfaces refuse to write.
   */
  checkWritePolicy?: WritePolicyCheck;
  /**
   * Cluster persistence. When omitted, crystallisation composes as
   * unavailable: migration 0005 still applies, the route answers 503, and
   * recall/Cluster is not published.
   */
  clusters?: ClusterStore;
  /** Clustering params + accretion threshold. Falls back to defaults. */
  crystallise?: CrystalliseConfig;
  /**
   * Probe backing the membership decay sweep: of these source rows, which are
   * gone? Answered as `memberKey` strings in one batched call — see
   * `CrystalliseCoreDeps.rowsMissing` for why the answer names the missing
   * rows rather than the surviving ones. Wired by the binary from the dataset
   * registry; when absent the sweep does not run (an embedded host with no
   * dataset resolver must not conclude every row has vanished).
   */
  rowsMissing?: (refs: readonly MemberRef[]) => Promise<Set<string>>;
  /**
   * Seam for the clustering pass itself, threaded to the route and the frame
   * surface. Omitted = the real `runClusterer` (worker_threads + wasm).
   */
  runClusterer?: (vectors: readonly Float32Array[], params: ClusterRunParams) => Promise<number[]>;
}

/**
 * Run two post-write hooks in sequence as one.
 *
 * Sequential rather than concurrent because each hook already swallows its own
 * failures, so there is nothing to race and ordering keeps the stderr trail
 * readable when both arms fail on the same row.
 */
function composeHooks(first: PostWriteHook | undefined, second: PostWriteHook): PostWriteHook {
  if (first === undefined) return second;
  return async (row, ctx) => {
    await first(row, ctx);
    await second(row, ctx);
  };
}

/**
 * Build the EmbedSourceContext factory threaded into each embedded type's
 * postWrite. The factory is invoked once per postWrite call, so the
 * closure stays small; the dataset lookup happens at `ctx.read(...)` time
 * inside the source function.
 */
function makeEmbedSourceContext(
  resolveDataset: (ns: string) => Dataset | null
): EmbedSourceContext {
  return {
    read: async (ns, type, params) => {
      const dataset = resolveDataset(ns);
      if (dataset === null) return null;
      const result = await dataset.read(type, { id: params.id });
      return result.rows[0] ?? null;
    }
  };
}

export function createRecallPlugin(cfg: RecallPluginConfig): KernelPlugin {
  const stats = cfg.stats ?? createEmbedStats();
  const queryEmbedder =
    cfg.embedder === undefined
      ? undefined
      : withEmbedTimeout(cfg.embedder, cfg.queryEmbedTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS);
  // The registries below are populated by contributePostWrites as namespaces
  // register, which happens after the substrate composes. Everything that
  // consumes them must read at call time rather than resolve eagerly.
  const spreadRegistry = new SpreadEdgeRegistry();
  const embedSourceRegistry = new EmbedSourceRegistry();
  const lexicalSourceRegistry = new LexicalSourceRegistry();
  const spreadResolver = makeSpreadResolver(spreadRegistry, cfg.edges ?? null);
  const expansionResolver = makeExpansionResolver(spreadRegistry, cfg.edges ?? null, {
    maxNeighboursPerSeed: cfg.expansion?.maxNeighboursPerSeed ?? 8,
    maxTotalNeighbours: cfg.expansion?.maxTotalNeighbours ?? 50
  });

  // Shared deps for the three recall-capable surfaces (kernelRoutes recall
  // POST, mcpTools recall, kernelNamespace recall/Hit), so an arm or
  // knob wired into one surface cannot be missing from the others. The other
  // routes have different dep shapes and are NOT covered by this bag.
  const recallCoreDeps = {
    ...(queryEmbedder !== undefined ? { embedder: queryEmbedder } : {}),
    store: cfg.store,
    ...(cfg.lexicalStore !== undefined ? { lexicalStore: cfg.lexicalStore } : {}),
    // Both registries are always threaded so recall can answer
    // `lexicalWhy` / `denseWhy: 'no-source'` for a type that declares no
    // source, instead of reporting an arm that cannot match as having run.
    lexicalSources: lexicalSourceRegistry,
    embedSources: embedSourceRegistry,
    ...(cfg.salience !== undefined ? { salience: cfg.salience } : {}),
    spreadResolver,
    expansionResolver,
    expansionEnabled: cfg.expansion?.enabled ?? true,
    // The counter only matters when the embed write path is active.
    ...(cfg.embedder !== undefined ? { stats } : {}),
    ...(cfg.checkReadPolicy !== undefined ? { checkReadPolicy: cfg.checkReadPolicy } : {}),
    // The frame surface reaches the same mutating cores as the kernel routes
    // (recall/boost, recall/fetchEmbeddings), so it needs the same write gate.
    ...(cfg.checkWritePolicy !== undefined ? { checkWritePolicy: cfg.checkWritePolicy } : {})
  };

  // ONE guard for this plugin instance, shared by the route AND the frame
  // surface (see crystallise-guard.ts's module doc). A guard built
  // separately per surface would let a route call race a frame call and
  // form duplicate clusters — the exact hole this instance closes.
  // On pg the store also supplies a cross-process lock.
  const formationLock = cfg.clusters?.withFormationLock?.bind(cfg.clusters);
  const crystalliseGuard = createCrystalliseGuard(
    formationLock === undefined ? {} : { crossProcess: formationLock }
  );

  // Crystallisation deps, shared by the route and the frame surface.
  //
  // `model` must be `embedder.modelId`: the write path stamps that string on
  // each embedding and `selectCandidates` filters on it, so any other value
  // silently yields zero candidates rather than an error.
  const crystalliseDeps =
    cfg.clusters === undefined
      ? undefined
      : {
          embeddings: cfg.store,
          clusters: cfg.clusters,
          model: cfg.embedder?.modelId ?? 'unknown',
          config: cfg.crystallise ?? DEFAULT_CRYSTALLISE_CONFIG,
          guard: crystalliseGuard,
          ...(cfg.rowsMissing !== undefined ? { rowsMissing: cfg.rowsMissing } : {}),
          ...(cfg.checkReadPolicy !== undefined ? { checkReadPolicy: cfg.checkReadPolicy } : {}),
          ...(cfg.runClusterer !== undefined ? { runClusterer: cfg.runClusterer } : {})
        };

  return {
    name: 'substrate-recall',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    storeTables: ['embeddings', 'lexical', 'recall_clusters', 'recall_cluster_members'],

    // Every boot, not once: migrations are recorded by id, so a store
    // whose first boot had no embedder kept the 768 default forever. Only
    // with an embedder configured, or a boot with it switched off would shrink
    // an empty column back to the default.
    async onKernelReady(ctx) {
      if (cfg.embedder === undefined || ctx.sql === null) return;
      let dimensionMismatch = false;
      const report = await alignVectorDimensions(
        ctx.sql as Parameters<typeof alignVectorDimensions>[0],
        {
          dimension: cfg.embedder.dimension,
          ...(cfg.migration?.hnswM !== undefined ? { hnswM: cfg.migration.hnswM } : {}),
          ...(cfg.migration?.hnswEfConstruction !== undefined
            ? { hnswEfConstruction: cfg.migration.hnswEfConstruction }
            : {})
        }
      );
      for (const [column, state] of [
        ['embeddings.embedding', report.embeddings],
        ['recall_clusters.centroid', report.centroids]
      ] as const) {
        if (state !== 'populated') continue;
        dimensionMismatch = true;
        const found = column.startsWith('embeddings')
          ? report.found.embeddings
          : report.found.centroids;
        ctx.metric('recall_dimension_mismatch', {
          column,
          stored: found,
          embedder: cfg.embedder.dimension,
          model: cfg.embedder.modelId
        });
        process.emitWarning(
          `${column} is vector(${found}) and holds rows, but the embedder is ${cfg.embedder.modelId} at ${cfg.embedder.dimension}. ` +
            'Writes to it will fail until the rows are cleared (they are derived) and re-embedded: delete them, restart, then POST /substrate/v1/embed/reindex.',
          { code: 'RECALL_DIMENSION_MISMATCH' }
        );
      }
      // Every re-embed would fail against a mismatched column, so there is nothing to retry.
      const intervalMs = cfg.embedBackfillIntervalMs ?? DEFAULT_EMBED_BACKFILL_INTERVAL_MS;
      const resolveDataset = cfg.resolveDataset;
      if (dimensionMismatch || intervalMs === 0 || resolveDataset === undefined) return;
      // shortcut: every process sharing the store runs this pass; the work is
      // idempotent, so duplicates cost embed calls only. Take a pg advisory lock
      // if a multi-process deployment makes that matter.
      const cursors = new Map<string, string>();
      let running = false;
      setInterval(() => {
        if (running) return;
        running = true;
        runEmbedBackfill({
          registry: embedSourceRegistry,
          store: cfg.store,
          resolveDataset,
          cursors,
          perTypeLimit: EMBED_BACKFILL_PER_TYPE
        })
          .then((r) => {
            if (r.embedded + r.failed === 0 && r.stopped === undefined) return;
            ctx.metric('recall_embed_backfill', r);
            process.stdout.write(`recall.embed_backfill ${JSON.stringify(r)}\n`);
          })
          .catch((err: unknown) => {
            process.stderr.write(
              `recall.embed_backfill failed: ${err instanceof Error ? err.message : String(err)}\n`
            );
          })
          .finally(() => {
            running = false;
          });
      }, intervalMs).unref();
    },

    migrations: [
      embeddingsMigration(cfg.migration ?? {}),
      // Always applied, even with no ClusterStore wired: the schema exists,
      // the surface it backs just isn't published yet.
      recallClustersMigration({
        dimension: cfg.migration?.dimension ?? DEFAULT_CLUSTER_DIMENSION
      }),
      // Likewise applied with no `lexicalStore` wired. Keep ordered by id.
      lexicalMigration(cfg.lexicalMigration ?? {})
    ],

    filterOperators:
      queryEmbedder !== undefined
        ? {
            embeddingSimilar: embeddingSimilarOperator({
              embedder: queryEmbedder,
              store: cfg.store
            })
          }
        : {},

    kernelRoutes: [
      {
        path: 'recall',
        method: 'POST',
        // Reads rows. The handler ALSO runs a `checkReadPolicy` probe per
        // (namespace, type), which is a different control: policy decides which
        // types a caller may see, the capability decides whether they may ask
        // at all. Recall
        // embeds the query before it filters anything, so an unauthenticated
        // caller who is ultimately shown nothing has still spent an embed.
        capability: 'read',
        handler: recallRouteHandler(recallCoreDeps)
      },
      {
        path: 'embed-stats',
        method: 'GET',
        // Operational counters, not row content — but they still describe the
        // shape of what is stored (volume, failure rates), so they follow the
        // read gate rather than going public.
        capability: 'read',
        handler: embedStatsRouteHandler(
          cfg.embedder !== undefined ? stats : undefined,
          embedSourceRegistry,
          lexicalSourceRegistry,
          // Composition, not registration: the registry knows what DECLARED a
          // source; only this knows whether a store was wired to receive it.
          // Store + resolver let opt-in ?coverage=true scan datasets and count
          // the live index.
          {
            lexicalEnabled: cfg.lexicalStore !== undefined,
            ...(cfg.lexicalStore !== undefined ? { lexicalStore: cfg.lexicalStore } : {}),
            ...(cfg.resolveDataset !== undefined ? { resolveDataset: cfg.resolveDataset } : {})
          }
        )
      },
      {
        // Raw-vector fetch for downstream dynamics consumers. Same read-policy
        // gate as recall: vectors leak content geometry. Also reinforces what
        // it returns, which is why it takes the salience config.
        path: 'embeddings/fetch',
        method: 'POST',
        capability: 'read',
        handler: embeddingsFetchRouteHandler({
          store: cfg.store,
          ...(cfg.embedder !== undefined ? { embedder: cfg.embedder } : {}),
          ...(cfg.salience !== undefined ? { salience: cfg.salience } : {}),
          ...(cfg.checkReadPolicy !== undefined ? { checkReadPolicy: cfg.checkReadPolicy } : {}),
          ...(cfg.checkWritePolicy !== undefined ? { checkWritePolicy: cfg.checkWritePolicy } : {})
        })
      },
      {
        // Explicit consumer-driven reinforcement (boost-on-use). No embedder
        // needed (no query text to embed). Gated on BOTH read and write
        // policy: a namespace may keep reads open while gating writes.
        path: 'salience/boost',
        method: 'POST',
        // Writes: boost-on-use mutates stored salience, so a caller who can
        // reach this can reshape everyone's recall ranking.
        capability: 'mutate',
        handler: salienceBoostRouteHandler({
          store: cfg.store,
          ...(cfg.embedder !== undefined ? { model: cfg.embedder.modelId } : {}),
          ...(cfg.salience !== undefined ? { salience: cfg.salience } : {}),
          ...(cfg.checkReadPolicy !== undefined ? { checkReadPolicy: cfg.checkReadPolicy } : {}),
          ...(cfg.checkWritePolicy !== undefined ? { checkWritePolicy: cfg.checkWritePolicy } : {})
        })
      },
      {
        // Always claimed: when cfg.clusters is absent the handler itself
        // answers 503 (see crystallise-route.ts).
        path: 'crystallise',
        method: 'POST',
        // Rebuilds cluster state across the whole embedding corpus — expensive
        // and global, so `mutate` rather than `read`.
        capability: 'mutate',
        handler: crystalliseRouteHandler({
          embeddings: cfg.store,
          ...(cfg.clusters !== undefined ? { clusters: cfg.clusters } : {}),
          model: crystalliseDeps?.model ?? 'unknown',
          config: cfg.crystallise ?? DEFAULT_CRYSTALLISE_CONFIG,
          guard: crystalliseGuard,
          ...(cfg.rowsMissing !== undefined ? { rowsMissing: cfg.rowsMissing } : {}),
          ...(cfg.checkReadPolicy !== undefined ? { checkReadPolicy: cfg.checkReadPolicy } : {}),
          ...(cfg.runClusterer !== undefined ? { runClusterer: cfg.runClusterer } : {})
        })
      },
      {
        // `admin` rather than `mutate`: this rewrites vectors for an entire
        // type, and `admin` is the only capability still enforced under
        // mode:'attribute'.
        path: 'embed/reindex',
        method: 'POST',
        capability: 'admin',
        handler: reindexRouteHandler({
          registry: embedSourceRegistry,
          ...(cfg.resolveDataset !== undefined ? { resolveDataset: cfg.resolveDataset } : {})
        })
      },
      {
        // `admin` for the same reason embed/reindex is: it
        // rewrites indexed text across a whole type, and `admin` is the only
        // capability compose enforces under mode:'attribute'.
        path: 'lexical/reindex',
        method: 'POST',
        capability: 'admin',
        handler: lexicalReindexRouteHandler({
          registry: lexicalSourceRegistry,
          ...(cfg.resolveDataset !== undefined ? { resolveDataset: cfg.resolveDataset } : {})
        })
      }
    ],

    mcpTools: [recallMcpTool(recallCoreDeps)],

    // Frame surface for the `recall` virtual namespace: recall/{Hit,boost,
    // fetchEmbeddings} delegate to the same transport-agnostic cores the
    // kernelRoutes above use. recall/{Cluster,ClusterMember,crystallise,
    // labelCluster} are only published when cfg.clusters is wired.
    kernelNamespace: buildRecallFrameSurface({
      ...recallCoreDeps,
      ...(crystalliseDeps !== undefined ? { clusterSurface: crystalliseDeps } : {})
    }),

    contributePostWrites(namespace) {
      // Register spread-opt-in crossRef fields first, regardless of whether
      // embeddings are wired, then build the post-write hooks.
      for (const [typeName, typeDef] of Object.entries(namespace.types ?? {})) {
        const fields = (typeDef.fields ?? {}) as Record<string, FieldDef>;
        for (const [fieldName, fieldDef] of Object.entries(fields)) {
          if (fieldDef.kind !== 'crossRef') continue;
          if (fieldDef.spread !== true) continue;
          spreadRegistry.add(namespace.namespace, typeName, {
            fieldName,
            targetNs: fieldDef.ns,
            targetType: fieldDef.type,
            ...(fieldDef.expandCrossType === true ? { expandCrossType: true } : {})
          });
        }
      }

      const out: Record<string, PostWriteHook> = {};

      // Lexical arm FIRST, and outside the embedder gate below, because it
      // does not need an embedder: keyword recall must not depend on one.
      if (cfg.lexicalStore !== undefined) {
        for (const [typeName, typeDef] of Object.entries(namespace.types ?? {})) {
          if (typeDef.lexical?.source === undefined) continue;
          // ONE binding for the write hook, the backfill re-index and the
          // coverage classifier, so a backfilled or covered row cannot drift
          // from a written one.
          const binding = {
            namespace: namespace.namespace,
            type: typeName,
            source: typeDef.lexical.source,
            store: cfg.lexicalStore
          };
          const hook = makeLexicalPostWrite(binding);
          out[typeName] = hook;
          lexicalSourceRegistry.add({
            namespace: namespace.namespace,
            type: typeName,
            hook,
            reindex: makeLexicalReindex(binding),
            // Pure classifier for dry-run coverage: no writes.
            classify: makeLexicalClassify(binding)
          });
        }
      }

      // Off-mode: no embedder configured. Substrate composes (migrations,
      // routes, etc.) but contributes zero EMBEDDING hooks — any lexical
      // hooks built above still stand.
      if (cfg.embedder === undefined) return out;
      // When the host has wired a dataset resolver, embed.source functions
      // get an EmbedSourceContext.read backed by it. Otherwise ctx stays
      // undefined and source functions work from row alone.
      const embedSourceContext =
        cfg.resolveDataset !== undefined ? makeEmbedSourceContext(cfg.resolveDataset) : undefined;
      // namespace.types may be undefined for hand-crafted NamespaceDefinitions
      // (tests, dynamically-built namespaces). Treat absence as "no contributions".
      for (const [typeName, typeDef] of Object.entries(namespace.types ?? {})) {
        if (typeDef.embed?.source === undefined) continue;
        // One binding, two consumers: the post-write hook and the re-embed
        // function share a source function, so a backfill cannot drift from
        // the write path.
        const binding = {
          namespace: namespace.namespace,
          type: typeName,
          source: typeDef.embed.source,
          embedder: cfg.embedder,
          store: cfg.store,
          stats,
          ...(embedSourceContext !== undefined ? { embedSourceContext } : {})
        };
        // Only the write path gets the cap; the re-embed (backfill) keeps the
        // embedder's own timeout, as before.
        const hook = makeEmbedPostWrite({
          ...binding,
          embedder: withEmbedTimeout(
            binding.embedder,
            cfg.writeEmbedTimeoutMs ?? DEFAULT_WRITE_EMBED_TIMEOUT_MS
          )
        });
        // COMPOSE rather than assign: a type declaring both arms already has a
        // lexical hook here, and assigning would silently drop it.
        out[typeName] = composeHooks(out[typeName], hook);
        // Retain what was just built so "which types are embedded" can be
        // answered without inferring it from stored rows.
        embedSourceRegistry.add({
          namespace: namespace.namespace,
          type: typeName,
          hook,
          reembed: makeReembed(binding)
        });
      }
      return out;
    }
  };
}
