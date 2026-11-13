/**
 * The Node and Bun client: the browser surface, plus env-driven signing,
 * `diagnose`, and the `node:http2` fetch that `substrateFetch` uses from here on.
 */

import { setSubstrateFetch } from './transport/default-fetch.js';
import { createH2Fetch } from './transport/h2-fetch.js';

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
export * from './browser.js';
export {
  type ClientFromEnv,
  type ClientFromEnvOptions,
  createClientFromEnv,
  resolveAgentCapabilities
} from './from-env.js';
export {
  createH2Fetch,
  type H2Fetch,
  type H2FetchOptions
} from './transport/h2-fetch.js';

// One process-wide HTTP/2 session pool, shared by every client that does not pass its own `fetch`.
setSubstrateFetch(createH2Fetch());
