/**
 * @mnmal-ai/substrate-core — resolution engine primitives.
 *
 * Consumers import types directly from @mnmal-ai/substrate-types and policy
 * combinators directly from @mnmal-ai/substrate-sdk. This package exports the
 * runtime pieces: registry, policy evaluator, in-memory edges store,
 * two-phase delete entry, and the sweep reconciler.
 */

// Re-exported from its home package for consumers that import it from substrate-core.
export { HttpBridgeClient } from '@mnmal-ai/substrate-bridge-http';
export { RestrictViolation } from '@mnmal-ai/substrate-types';
/**
 * @internal — §6.4 lost-namespace handler, used by `engine.ts`. Exported for
 * custom-engine integrators but treated as package-private; the signature may
 * change.
 */

export {
  type ReadShape,
  readShapeOf,
  ShapeRecorder,
  shapeKey
} from './advisor/shape-recorder.js';
export { nextKeys } from './advisor/walk-service.js';
export { BridgeUnreachableError } from './bridge-unreachable-error.js';
export { setCursorSealSecret } from './engine/cursor-seal.js';
export {
  Engine,
  type EngineInput,
  type EngineOptions,
  type FrameEntry,
  type MetricFn,
  type NamespaceConfig,
  type QualifiedFrame,
  type StreamHandle,
  type StreamInput,
  type SubscriptionCancelReason,
  type SubscriptionHandle
} from './engine/engine.js';
export {
  clearExtensionOperators,
  effectiveFilterOperators,
  getExtensionOperator,
  registerExtensionOperator
} from './filter/validator.js';
export { assertHardDeleteAllowed, validateHardDeleteEnv } from './hard-delete-gate.js';
export { loadPlugins, PluginNamespaceCollision } from './load-plugins.js';
export { MemoryBridgeCredentialStore } from './memory-bridge-credential-store.js';
export { MemoryBridgeRegistry } from './memory-bridge-registry.js';
export { MemoryEdgesStore } from './memory-edges-store.js';
export { MemoryIdempotencyStore } from './memory-idempotency-store.js';
export { applyObligations, evaluatePolicy } from './policy-evaluator.js';
export {
  DuplicateRegistration,
  Registry,
  type RegistryEntry,
  type RegistryEntryInput,
  type Resolver
} from './registry.js';
export { ResolverFrameError } from './resolver-frame-error.js';
export {
  createRuntimeStats,
  type RuntimeStats,
  type RuntimeStatsSnapshot
} from './runtime-stats.js';
export { publishSchema } from './schema-publisher.js';
export { applyPolicy, loadSweepState, runSweep, saveSweepState } from './sweep.js';
export { TaskScheduler } from './task-scheduler.js';
export { usesWalkGrammar, walkGrammarPath } from './walk-gate.js';
