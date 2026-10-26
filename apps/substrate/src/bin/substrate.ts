#!/usr/bin/env node
import { assertNodeVersion } from '../node-version.js';

// Before the CLI loads: static imports would evaluate all of it first.
assertNodeVersion();

// Not a top-level await: `mcp` never settles, and ends when the host closes
// stdin and the event loop drains. Under a top-level await that drain exits 13
// with "unsettled top-level await"; this way it exits 0 after in-flight replies.
void import('../cli.js')
  .then(({ runCli }) => runCli(process.argv.slice(2)))
  .then((code) => process.exit(code));
