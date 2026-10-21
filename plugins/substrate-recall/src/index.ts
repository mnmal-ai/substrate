/**
 * @mnmal-ai/substrate-recall — the recall substrate plugin.
 *
 * Owns the embedder, the dense (pgvector) and lexical recall arms, and
 * crystallisation. Provides, among others:
 *   - SubstrateMigrations: embeddings, lexical, recall clusters
 *   - FilterOperator: embeddingSimilar (where-clause recall)
 *   - KernelRoutes: POST /substrate/v1/recall, GET /substrate/v1/embed-stats, reindex routes
 *   - McpTool: recall
 *   - Primitives: EmbeddingsStore, LexicalStore, embedAndStore for plugin authors
 *
 * `createRecallPlugin` is the factory for direct programmatic callers.
 */

import pkg from '../package.json' with { type: 'json' };

export const RECALL_VERSION: string = pkg.version;

export {
  type Candidate,
  type CandidateSelector,
  SELECT_CANDIDATES_MAX_LIMIT,
  validateSelector
} from './candidate-selection.js';
export {
  buildClusterSurface,
  CLUSTER_FIELDS,
  CLUSTER_MEMBER_FIELDS,
  type ClusterSurfaceDeps
} from './cluster-frame-surface.js';
export type {
  ClusterMemberRecord,
  ClusterProvenance,
  ClusterRecord,
  ClusterStore,
  MemberRef,
  NewCluster,
  NewMember
} from './cluster-store.js';
export { memberKey } from './cluster-store.js';
export { CLUSTERER_BACKEND, CLUSTERER_BACKEND_VERSION } from './clusterer-version.js';
export {
  type CrystalliseConfig,
  type CrystalliseCoreDeps,
  type CrystalliseInput,
  type CrystalliseOutput,
  DEFAULT_CRYSTALLISE_CONFIG,
  handleCrystallise,
  validateCrystalliseInput
} from './crystallise-core.js';
export {
  CRYSTALLISE_IN_FLIGHT_CODE,
  type CrystalliseGuard,
  createCrystalliseGuard
} from './crystallise-guard.js';
export { type CrystalliseRouteConfig, crystalliseRouteHandler } from './crystallise-route.js';
export {
  type EmbedAndStoreOptions,
  type EmbedBinding,
  type EmbedOutcome,
  embedAndStore,
  embedRowReporting,
  makeEmbedPostWrite,
  makeReembed
} from './embed-and-store.js';
export {
  type EmbeddedTypeRef,
  type EmbedSourceEntry,
  EmbedSourceRegistry
} from './embed-source-registry.js';
export {
  createEmbedStats,
  type EmbedStats,
  type EmbedStatsSnapshot
} from './embed-stats.js';
export {
  type EmbedStatsComposition,
  type EmbedStatsResponse,
  embedStatsRouteHandler,
  handleEmbedStatsRequest
} from './embed-stats-route.js';
export {
  EMBEDDINGS_FETCH_MAX_REFS,
  type EmbeddingsFetchRouteConfig,
  embeddingsFetchRouteHandler
} from './embeddings-fetch-route.js';
export type {
  EmbeddingsStore,
  EmbeddingsStoreDeleteInput,
  EmbeddingsStoreFetchResult,
  EmbeddingsStoreKnnInput,
  EmbeddingsStoreKnnResult,
  EmbeddingsStoreUpsertInput
} from './embeddings-store.js';
export { embeddingSimilarOperator } from './filter-operator.js';
export {
  InMemoryClusterStore,
  type InMemoryClusterStoreOptions
} from './in-memory-cluster-store.js';
export {
  InMemoryEmbeddingsStore,
  type InMemoryEmbeddingsStoreOptions
} from './in-memory-embeddings-store.js';
export {
  InMemoryLexicalStore,
  type InMemoryLexicalStoreOptions
} from './in-memory-lexical-store.js';
export { l2normalize } from './l2normalize.js';
export {
  handleLexicalCoverage,
  type LexicalCoverageDeps,
  type LexicalCoverageInput,
  type LexicalCoverageResult,
  type LexicalTypeCoverage,
  validateLexicalCoverageInput
} from './lexical-coverage-core.js';
export {
  type LexicalPostWriteBinding,
  makeLexicalClassify,
  makeLexicalPostWrite
} from './lexical-index.js';
export type { LexicalClassifyOutcome } from './lexical-source-registry.js';
export type {
  LexicalStore,
  LexicalStoreDeleteInput,
  LexicalStoreSearchInput,
  LexicalStoreSearchResult,
  LexicalStoreUpsertInput
} from './lexical-store.js';
export {
  type RecallMcpToolConfig,
  recallMcpTool
} from './mcp-tool.js';
export {
  type EmbeddingsMigrationOptions,
  embeddingsMigration
} from './migrations/0001_embeddings.js';
export {
  type RecallClustersMigrationOptions,
  recallClustersMigration
} from './migrations/0002_recall_clusters.js';
export {
  type LexicalMigrationOptions,
  lexicalMigration
} from './migrations/0003_lexical.js';
export { checkParams, unknownParamMessage, unknownParams } from './params.js';
export { PgClusterStore, type PgClusterStoreOptions } from './pg-cluster-store.js';
export { PgEmbeddingsStore, type PgEmbeddingsStoreOptions } from './pg-embeddings-store.js';
export { PgLexicalStore, type PgLexicalStoreOptions } from './pg-lexical-store.js';
// Factory + config type — primary entry point for direct programmatic
// callers (binary compose, tests). The structured-config `bootstrap` is the
// canonical entry for the binary's SUBSTRATE_PLUGIN_DIR loader, imported
// separately via `@mnmal-ai/substrate-recall/bootstrap`.
export { createRecallPlugin, type RecallPluginConfig } from './plugin.js';
export {
  handleRecallRequest,
  type ReadPolicyCheck,
  type RecallInput,
  type RecallOutput,
  type RecallRouteConfig,
  type RecallRow,
  recallRouteHandler
} from './recall-route.js';
export {
  handleReindex,
  REINDEX_DEFAULT_LIMIT,
  REINDEX_MAX_LIMIT,
  type ReindexCoreDeps,
  type ReindexFailure,
  type ReindexInput,
  type ReindexResult,
  validateReindexInput
} from './reindex-core.js';
export { type ReindexRouteConfig, reindexRouteHandler } from './reindex-route.js';
export { type ArmRank, armRanks, fuseByRank, RRF_K } from './rrf.js';
export { type ClusterRunParams, runClusterer } from './run-clusterer.js';
export type { SalienceBoostResult } from './salience-boost-core.js';
export {
  SALIENCE_BOOST_MAX_TARGETS,
  type SalienceBoostRouteConfig,
  salienceBoostRouteHandler
} from './salience-boost-route.js';
