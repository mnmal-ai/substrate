export type {
  ProcessStat,
  ResolverStat,
  RuntimeErrorEntry,
  RuntimeErrors,
  RuntimeMetrics,
  SlowRequest
} from '@mnmal-ai/substrate-types';
export type {
  AdminApi,
  AdminGrantChange,
  AdminInviteInput,
  AdminInviteResult,
  AdminKeyAlgorithm,
  AdminKeyRow,
  AdminRegisterInput,
  AdminRegisterResult,
  AdminRevokeResult,
  AdminUpdateResult
} from './admin/api.js';
export {
  DIAGNOSE_CHECKS,
  type DiagnoseCredential,
  type DiagnoseFacts,
  type DiagnoseOpts,
  type DiagnoseResult,
  type DirectoryReconciliation,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  diagnose,
  reconcileIdentities
} from './admin/diagnose.js';
export {
  CURRENT_MARK,
  currentStep,
  ONBOARD_STEPS,
  type OnboardAction,
  type OnboardStep,
  type OnboardStepStatus,
  type PlanOnboardingOpts,
  planOnboarding,
  requiredOutstanding,
  SKIPPABLE_STEPS,
  STEP_MARKS
} from './admin/onboard.js';
export {
  type AdminBackfillChunk,
  AdminBackfillError,
  type AdminBackfillInput,
  type AdminBackfillSummary,
  type AdminDropCascade,
  type AdminDropNamespaceInput,
  type AdminDropResult,
  type AdminDropTypeInput,
  type AdminEmbedStats,
  type AdminNormaliseInput,
  type AdminNormaliseResult,
  type AdminReindexInput,
  type AdminReindexPage,
  BACKFILL_CHUNK,
  type SurgeryApi
} from './admin/surgery.js';
export { type CallOpts, SubstrateClient, type SubstrateClientOptions } from './client.js';
export {
  collectDiagnostics,
  createDefaultDiagnosticsSink,
  type Diagnostic,
  type DiagnosticsSink
} from './diagnostics.js';
export { AuthError, NetworkError, SchemaDriftError, SubscribeError } from './errors.js';
export {
  type ClientFromEnv,
  type ClientFromEnvOptions,
  createClientFromEnv,
  resolveAgentCapabilities
} from './from-env.js';
export type {
  NlApi,
  NlAskRequest,
  NlAskResult,
  NlOutcome,
  NlServedPack,
  NlTrailEvent,
  NlWireEvent
} from './nl.js';
export {
  DEFAULT_MAX_WRITES,
  type RunScriptOptions,
  runScript,
  type ScriptContext,
  type ScriptMode,
  type ScriptMutation,
  type ScriptRecallHit,
  type ScriptRecallInput,
  type ScriptReport
} from './script.js';
// Low-level fold primitives behind `SubstrateClient.watch`, exported for consumers
// that own their own subscription loop (e.g. a bespoke resubscribe wrapper) but
// still want the typed-row reduction instead of hand-decoding the data envelope.
export { reduceSubscribeRows, watchRows } from './subscribe-rows.js';
export { noRedirectFetch, tokenAudience } from './token-target.js';
export type { QualifiedFrame } from './transport/http.js';
export type { SubscribeEvent, WebSocketImpl, WsOverloadResubscribeOpts } from './transport/ws.js';
