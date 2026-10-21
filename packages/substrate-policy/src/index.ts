/**
 * @mnmal-ai/substrate-policy — policy combinators and primitives. Spec: §4.4.
 */

export {
  type AdminCredential,
  type AdminEnv,
  resolveAdminCredential,
  resolveDefaultKeyPath,
  resolveDefaultKidPath
} from './admin-credential.js';
export { describeGrant, isActiveAdminKeyRow, SYSTEM_NAMESPACE } from './admin-key.js';
export {
  ADMIN_CAPABILITIES,
  adminClaimCapabilities,
  DEFAULT_CAPABILITIES,
  isEncryptedKey,
  makeAuthorizationProvider,
  makeTokenProvider,
  type TokenProviderOpts
} from './agent-token.js';
export { and, not, or } from './combinators.js';
export { decodeList, encodeList } from './encoding.js';
export {
  capabilitiesFor,
  encodeGrant,
  expandFlat,
  flattenGrant,
  type Grant,
  grantEntryError,
  grantIsUniform,
  intersectGrants,
  parseGrantEntries
} from './grant.js';
export {
  checkRevocable,
  checkUpdatable,
  grantCovers,
  grantEntriesConfer,
  type KeyMutationRefusal,
  type KeyUpdateRefusal,
  newlyGranted,
  newlyGrantedPairs,
  revokedAtIso
} from './key-guards.js';
export {
  allowAll,
  allowVerbs,
  denyAll,
  denyVerbs,
  requireCapability,
  requireIdentity,
  requireNamespace
} from './primitives.js';
export { applyRowFilters, row } from './row.js';
