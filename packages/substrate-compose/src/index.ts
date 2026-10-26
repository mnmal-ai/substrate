/**
 * @mnmal-ai/substrate-compose — composition root for the Substrate binary, consumable
 * by workspace packages (e.g. for integration tests) without depending on the
 * app.
 *
 * Public surface groups:
 *   - **Composition root** — `compose`, `ComposeOpts`, `ComposeResult`,
 *     `Capability`, `DEFAULT_NAMESPACE`.
 *   - **Auth** — `AuthConfig`, `AuthConfigError`, `parseAuthConfig`,
 *     `signHs256`, `signEdDSA`, `extractBearer`, `authenticateBearer`,
 *     `verifyBearerToken`, `credentialLapse`.
 *   - **`_system` admin namespace** — every re-export from `./_system/index.js`
 *     (key types, invite types, audit helpers, registry, rate limiter,
 *     routes, sweep).
 */

export * from './_system/index.js';
export {
  type AdvisorDeps,
  type AdvisorState,
  planServesShape,
  runAdvisorPass
} from './advisor/advisor.js';
export {
  isStoreProfileName,
  PROFILES,
  type ProfileThresholds,
  type StoreProfileName
} from './advisor/profiles.js';
export {
  type AuthConfig,
  AuthConfigError,
  type AuthKey,
  extractBearer,
  parseAuthConfig,
  signEdDSA,
  signHs256,
  verifyBearerToken
} from './auth.js';
export {
  type Capability,
  type ComposeOpts,
  type ComposeResult,
  compose,
  DEFAULT_NAMESPACE,
  withAuth
} from './compose.js';
export {
  type ContractCheck,
  type ContractViolation,
  composeFromManifests,
  type KernelHostDeps,
  PluginLoadError,
  type ResolvedBootstrap
} from './compose-from-manifests.js';
export {
  composeKernelPlugins,
  type KernelComposeContext,
  kernelMigrationTracking,
  mountKernelRoute
} from './kernel.js';
export type { ConfigReport, KnobReport } from './routes/config-echo.js';
export {
  buildContext,
  error400,
  JSON_HEADERS,
  jsonResponse,
  parseJsonBody
} from './routes/helpers.js';
