#!/usr/bin/env node
/**
 * `substrate-admin` entrypoint, and nothing else: it checks the Node version,
 * then loads the CLI (`../admin/run.ts`) dynamically, because static imports
 * would evaluate the whole CLI before the check. The public surface is
 * `../admin/index.ts`.
 */

import { isEntrypointPath } from '../admin/entrypoint.js';
import { assertNodeVersion } from '../node-version.js';

// Guarded, so importing this module (a test, a bundler) never runs the CLI.
if (isEntrypointPath(import.meta.url, process.argv[1])) {
  assertNodeVersion();
  void import('../admin/run.js').then(({ runAdminCli }) => runAdminCli());
}
