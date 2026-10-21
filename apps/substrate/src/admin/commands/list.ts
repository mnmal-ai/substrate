/**
 * `list` — print the active Key rows.
 *
 * Without `--url`: read-only, direct-to-postgres, and it DOES NOT
 * AUTHENTICATE, so an admin row here is no evidence admin auth works — that is
 * `doctor`'s question. With `--url`: an authenticated read through the server.
 */

import { KEY_TYPE } from '@mnmal-ai/substrate-compose';
import type { RowMetadata } from '@mnmal-ai/substrate-types';
import { validateArgv } from '../argv.js';
import { type OpenDatasetFn, openPgDataset } from '../dataset.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import { argvError } from '../usage.js';

export interface ListedKeyRow {
  kid: string;
  name: string;
  capabilities: string;
  namespaces: string;
  createdAt: string;
}

/**
 * Parse `list`'s arguments. Returns the `--url` base when one was given.
 */
export function parseListArgs(argv: readonly string[]): { url?: string } {
  try {
    return parseListArgsInner(argv);
  } catch (err) {
    if (err instanceof AdminCliError) throw argvError('list', err.message, err.exitCode);
    throw err;
  }
}

function parseListArgsInner(argv: readonly string[]): { url?: string } {
  // `list` is handed the TAIL, with no subcommand name to skip. Unknown flags
  // and stray positionals are refused per `ARGV_SPEC`; what remains here is
  // the value guard.
  validateArgv('list', argv);
  const out: { url?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok === '--url') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new AdminCliError('list: --url requires a base URL, e.g. --url https://host:3100', 1);
      }
      out.url = value;
      i += 1;
      continue;
    }
    if (tok.startsWith('--url=')) {
      const value = tok.slice('--url='.length);
      if (value === '') {
        throw new AdminCliError('list: --url requires a base URL, e.g. --url https://host:3100', 1);
      }
      out.url = value;
    }
  }
  return out;
}

export async function runList(
  env: AdminCliEnv,
  openDataset: OpenDatasetFn = openPgDataset
): Promise<Array<ListedKeyRow>> {
  const { dataset, close } = await openDataset(env);
  try {
    const { rows } = await dataset.read(KEY_TYPE, {
      where: { revokedAt: { eq: null } }
    });
    const out: Array<ListedKeyRow> = [];
    for (const row of rows) {
      const kid = typeof row.kid === 'string' ? row.kid : '';
      if (kid.length === 0) continue;
      // Defensive re-check: `where: { revokedAt: { eq: null } }` is honoured by
      // both memory and pg datasets, but substrate drift would silently leak
      // revoked rows into `list` output. Skipping explicitly is cheap.
      if (row.revokedAt != null) continue;
      const meta = row._metadata as RowMetadata | undefined;
      const createdAt = meta?.createdAt ?? '';
      out.push({
        kid,
        name: typeof row.name === 'string' ? row.name : '',
        capabilities: typeof row.capabilities === 'string' ? row.capabilities : '',
        namespaces: typeof row.namespaces === 'string' ? row.namespaces : '',
        createdAt
      });
    }
    return out;
  } finally {
    await close();
  }
}

/**
 * Provenance line, printed with every result including the empty one, so an
 * unauthenticated direct read is not mistaken for proof that admin auth works
 * — or, when empty, for proof that the right store is empty.
 */
const PROVENANCE =
  'read directly from SUBSTRATE_DATABASE_URL — NOT authenticated, and not a check that any credential works.\n' +
  'To ask a running server whether admin auth actually works: substrate-admin doctor --url <base>\n';

export function formatListOutput(rows: Array<ListedKeyRow>): string {
  if (rows.length === 0) {
    return `no active Key rows\n${PROVENANCE}`;
  }
  return `${formatTable(rows)}${PROVENANCE}`;
}

/** The aligned table, shared by both modes so they cannot drift apart. */
function formatTable(rows: Array<ListedKeyRow>): string {
  const header: ListedKeyRow = {
    kid: 'kid',
    name: 'name',
    capabilities: 'capabilities',
    namespaces: 'namespaces',
    createdAt: 'createdAt'
  };
  const all = [header, ...rows];
  const widths = {
    kid: Math.max(...all.map((r) => r.kid.length)),
    name: Math.max(...all.map((r) => r.name.length)),
    capabilities: Math.max(...all.map((r) => r.capabilities.length)),
    namespaces: Math.max(...all.map((r) => r.namespaces.length)),
    createdAt: Math.max(...all.map((r) => r.createdAt.length))
  };
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  const divider = [
    '-'.repeat(widths.kid),
    '-'.repeat(widths.name),
    '-'.repeat(widths.capabilities),
    '-'.repeat(widths.namespaces),
    '-'.repeat(widths.createdAt)
  ].join('  ');
  const lines = [
    [
      pad(header.kid, widths.kid),
      pad(header.name, widths.name),
      pad(header.capabilities, widths.capabilities),
      pad(header.namespaces, widths.namespaces),
      pad(header.createdAt, widths.createdAt)
    ].join('  '),
    divider
  ];
  for (const r of rows) {
    lines.push(
      [
        pad(r.kid, widths.kid),
        pad(r.name, widths.name),
        pad(r.capabilities, widths.capabilities),
        pad(r.namespaces, widths.namespaces),
        pad(r.createdAt, widths.createdAt)
      ].join('  ')
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render the AUTHENTICATED read, naming the target and stating that the
 * server verified the credential before answering.
 */
export function formatRemoteListOutput(
  rows: Array<Record<string, unknown>>,
  baseUrl: string
): string {
  const mapped: Array<ListedKeyRow> = rows.map((r) => ({
    kid: typeof r.kid === 'string' ? r.kid : '',
    name: typeof r.name === 'string' ? r.name : '',
    capabilities: typeof r.capabilities === 'string' ? r.capabilities : '',
    namespaces: typeof r.namespaces === 'string' ? r.namespaces : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : ''
  }));
  const provenance = `read from ${baseUrl} over the admin-gated route — AUTHENTICATED, and the server accepted this credential.\n`;
  if (mapped.length === 0) return `no active Key rows\n${provenance}`;
  return `${formatTable(mapped)}${provenance}`;
}
