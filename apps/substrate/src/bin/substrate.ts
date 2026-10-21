#!/usr/bin/env node
import { runCli } from '../cli.js';

// Not a top-level await: `mcp` never settles, and ends when the host closes
// stdin and the event loop drains. Under a top-level await that drain exits 13
// with "unsettled top-level await"; this way it exits 0 after in-flight replies.
void runCli(process.argv.slice(2)).then((code) => process.exit(code));
