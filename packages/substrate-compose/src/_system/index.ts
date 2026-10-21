/**
 * Barrel re-exports for the `_system` namespace module. Spec §5.12.
 */

export {
  capabilitiesFor,
  checkRevocable,
  checkUpdatable,
  decodeList,
  encodeList,
  type Grant,
  grantCovers,
  grantEntriesConfer,
  grantEntryError,
  isActiveAdminKeyRow,
  type KeyMutationRefusal,
  type KeyUpdateRefusal,
  newlyGranted,
  parseGrantEntries,
  revokedAtIso
} from '@mnmal-ai/substrate-policy';
export { whoamiRoute } from '../routes/whoami.js';
export {
  BACKFILL_MAX_ROWS,
  type BackfillFieldRouteDeps,
  backfillFieldRoute
} from './backfill-field.js';
export {
  type AuditEmitInput,
  buildAuditRow,
  type InstalledSystemNamespace,
  type InstallSystemNamespaceOptions,
  installSystemNamespace
} from './install.js';
export {
  type InviteSweepResult,
  type RunInviteSweepOptions,
  runInviteSweep
} from './invite-sweep.js';
export { type NormaliseVocabRouteDeps, normaliseVocabRoute } from './normalise-vocab.js';
export {
  type CreateRateLimiterOptions,
  createRateLimiter,
  type RateLimiter,
  type RateLimitResult
} from './rate-limit.js';
export {
  type CreateKeyRegistryOptions,
  createKeyRegistry,
  type KeyRecord,
  type KeyRegistry
} from './registry.js';
export {
  extractClientIp,
  invitesRoute,
  type KeysRouteOptions,
  keyPatchRoute,
  keysRoute,
  registerRoute
} from './routes.js';
export {
  type CreateSigningKeyResolverOptions,
  createSigningKeyResolver,
  type SigningKeyMetric
} from './signing-key.js';
export {
  AUDIT_EVENT_FIELDS,
  AUDIT_EVENT_KINDS,
  AUDIT_EVENT_TYPE,
  type AuditEventKind,
  ENUM_VERDICT_FIELDS,
  ENUM_VERDICT_TYPE,
  type IdentityDirectoryConfig,
  INVITE_FIELDS,
  INVITE_TYPE,
  isKeyAlgorithm,
  KEY_ALGORITHMS,
  KEY_FIELDS,
  KEY_TYPE,
  type KeyAlgorithm,
  SIGNING_KEY_FIELDS,
  SIGNING_KEY_TYPE,
  SYSTEM_NAMESPACE
} from './types.js';
export {
  MigrationError,
  type MigrationPlan,
  type MigrationResult,
  type MigrationScan,
  migrateFieldValues,
  type Offender,
  planMigration,
  type ScanDeps,
  scanNonconforming,
  type ValueMap
} from './value-map-migration.js';
