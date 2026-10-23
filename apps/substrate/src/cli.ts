/**
 * Substrate CLI dispatcher. The unified `substrate` binary dispatches on argv[2]:
 *
 *   substrate serve       — boot the HTTP/WS server (./main.ts)
 *   substrate mcp         — boot the stdio MCP transport (./mcp/server.ts)
 *   substrate init        — scaffold a runtime directory (./cli/init)
 *   substrate check-enums — report stored values outside declared enums
 *   substrate normalise-vocab — rewrite stored vocabulary aliases to canonical values
 *   substrate backfill-field  — write per-row values of one field, metadata preserved
 *   substrate ask         — ask a natural-language question (./cli/ask)
 *   substrate run         — run a script against a signed, guarded client (./cli/run)
 *   substrate federate    — enroll / join / check bridges (./cli/federate)
 *
 * No flags-vs-subcommand ambiguity: subcommands are always argv[2].
 * Unknown / missing subcommand prints help and exits non-zero.
 */

import pkg from '../package.json' with { type: 'json' };
import { runAsk } from './cli/ask/main.js';
import { runBackfillField } from './cli/backfill-field/main.js';
import { runCheckEnums } from './cli/check-enums/main.js';
import { runFederate } from './cli/federate/main.js';
import { runInit } from './cli/init/main.js';
import { runNormaliseVocab } from './cli/normalise-vocab/main.js';
import { runRun } from './cli/run/main.js';
import { runServe } from './main.js';
import { runMcp } from './mcp/server.js';

const HELP = `substrate — the Substrate CLI

Usage:
  substrate <subcommand> [args...]
  substrate --version           Print this binary's package version (also -v, version).
  substrate <subcommand> --help Print this help.

Subcommands:
  serve                     Boot the Substrate HTTP/WS server (default port 3100).
  mcp                       Boot the stdio MCP server. Reads SUBSTRATE_URL, and
                            SUBSTRATE_MCP_TOOLS (csv) to register only those tools.
  init [dir] [flags]        Scaffold a new Substrate runtime directory. Interactive by
                            default; pass --yes for non-interactive scripted use.
  federate <verb>           Federation onboarding: enroll / join / check.
                            Run \`substrate federate\` for the verb list.
  ask <question>            Ask a natural-language question (needs the substrate-nl plugin).
                            Flags: --ns, --project, --json. Reads SUBSTRATE_URL.
  run <script.mts> [--args <json>] [--dry-run | --write] [--max-writes <n>] [--out <file>]
                            Run a script's default export (s) => result against a client
                            signed from SUBSTRATE_URL + SUBSTRATE_AGENT_KEY_ID/_PATH, and
                            print one JSON report. --args is a JSON object, read as
                            s.args. Read-only unless --dry-run (records mutations) or
                            --write (sends up to --max-writes frames, 50).
  check-enums [--json] [--record]
                            Report stored values outside a field's declared enum.
                            Read-only over HTTP (--record writes verdict rows); reads
                            SUBSTRATE_URL and SUBSTRATE_ENUM_CHECK_TOKEN. Exit 1 on
                            drift, so it works as a CI/cron gate.
  normalise-vocab <ns> <Type> <field> [--apply] [--reject a,b] [--json]
                            Rewrite stored aliases to their canonical value. Dry run
                            unless --apply. Admin: reads SUBSTRATE_URL and
                            SUBSTRATE_ADMIN_TOKEN.
  backfill-field <ns> <Type> <field> --values <file.json> [--apply] [--overwrite] [--json]
                            Write per-row values of one field, metadata preserved. Dry
                            run unless --apply. Admin: reads SUBSTRATE_URL and
                            SUBSTRATE_ADMIN_TOKEN.

Environment for \`serve\` (the load-bearing ones; the full reference is in the docs):
  SUBSTRATE_DATABASE_URL          'memory' (default) or 'postgres://...'
  SUBSTRATE_PLUGIN_DIR            Abs path to plugin install root (manifest-driven loader)
  PORT                            Listen port (default 3100)
  HOST                            Listen address (default 0.0.0.0, or 127.0.0.1 when
                                  auth is off). A non-loopback HOST with auth off fails
                                  boot unless SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST=1.
  SUBSTRATE_AUTH_MODE             'attribute' or 'required'. Setting this or
                                  SUBSTRATE_AUTH_KEY_REGISTRY enables auth; with
                                  neither, every request is anonymous.
  SUBSTRATE_STREAM_TICKET_SECRET  HMAC key signing the SSE stream tickets. REQUIRED when
                                  auth is enabled — boot fails without it. Minimum 16
                                  characters after trimming. The ticket signature is the
                                  ONLY authentication on GET /substrate/v1/stream and
                                  GET /substrate/v1/subscribe (EventSource can send no
                                  header or body). Rotating it invalidates every
                                  outstanding ticket, which is the only revocation
                                  mechanism.
  SUBSTRATE_PUBLIC_ORIGIN         This server's origins, comma-separated (e.g.
                                  https://host:3100,https://alias). A token must carry
                                  'aud' naming one; a token with no 'aud' is refused.
                                  Required with auth on a non-loopback
                                  HOST; on loopback it defaults to the loopback origins.
  SUBSTRATE_TLS_KEY_PATH          Serve HTTPS. Both are required together — setting one
  SUBSTRATE_TLS_CERT_PATH         without the other refuses to boot.
  SUBSTRATE_NAMESPACE             Default namespace for recall requests that omit one.
                                  Without it such requests are refused rather than
                                  guessing a namespace that may not exist.

Natural-language query and the recall embedder are configured by plugin config
files under SUBSTRATE_PLUGIN_DIR (substrate-nl.config.json,
substrate-recall.config.json), not by environment variables.

See https://github.com/mnmal-ai/substrate for the full env reference.
`;

export async function runCli(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(HELP);
    return subcommand === undefined ? 1 : 0;
  }

  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  // federate prints its own verb list; the others would boot, or misread the flag.
  if (subcommand !== 'federate' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (subcommand) {
    case 'serve':
      await runServe();
      // runServe sets up the server (Fastify listening socket + sweep timers
      // + SIGTERM/SIGINT handlers) then returns. The listening socket alone
      // would keep Node's event loop alive — but bin/substrate.ts unconditionally
      // calls `process.exit(code)` after this Promise resolves, which kills
      // the listening socket synchronously. So we block here forever; the
      // graceful-shutdown handlers registered inside runServe are the only
      // exit path.
      await new Promise<never>(() => {});
      // Unreachable; the never-resolving promise above blocks indefinitely.
      return 0;
    case 'mcp':
      await runMcp();
      // runMcp connects the StdioServerTransport and returns. Its stdin
      // listeners alone would normally keep Node's event loop alive — but
      // bin/substrate.ts unconditionally calls `process.exit(code)` after this
      // Promise resolves, which kills the process before any MCP traffic
      // can flow. Block here forever so the transport handles the lifecycle;
      // the host (Claude Code, etc.) closes stdio to terminate.
      await new Promise<never>(() => {});
      // Unreachable; the never-resolving promise above blocks indefinitely.
      return 0;
    case 'init':
      return await runInit(rest);
    case 'check-enums':
      return await runCheckEnums(rest);
    case 'normalise-vocab':
      return await runNormaliseVocab(rest);
    case 'backfill-field':
      return await runBackfillField(rest);
    case 'ask':
      return await runAsk(rest);
    case 'run':
      return await runRun(rest);
    case 'federate':
      return await runFederate(
        rest,
        process.env,
        (s) => process.stdout.write(s),
        (s) => process.stderr.write(s)
      );
    default:
      process.stderr.write(`substrate: unknown subcommand '${subcommand}'\n\n`);
      process.stderr.write(HELP);
      return 1;
  }
}
