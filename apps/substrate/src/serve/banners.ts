/**
 * Boot banners — pure string builders. Each states a posture out loud so a
 * silent default (memory store, no plugins, wrong scheme) is not mistaken for
 * its opposite.
 */

import type { ConfigReport } from '@mnmal-ai/substrate-compose';

/**
 * The "listening at" line, with the scheme matching whether TLS is on.
 * Operators copy a base URL from here, and `substrate federate enroll --origin`
 * validates the scheme.
 */
export function listeningBanner(address: string, port: number, tlsEnabled: boolean): string {
  const scheme = tlsEnabled ? 'https' : 'http';
  return `@mnmal-ai/substrate listening at ${scheme}://${address}:${port}\n`;
}

/**
 * The "you have a server that can do nothing" banner, for a plugin-less boot
 * that mounts only `_system` admin + `/health`.
 *
 * Unset and set-but-empty get different text because they have different
 * fixes: point SUBSTRATE_PLUGIN_DIR somewhere, or install packages under
 * `<dir>/node_modules`.
 */
export function noPluginsBanner(pluginDir: string | null): string {
  const lines =
    pluginDir === null
      ? [
          '│ SUBSTRATE_PLUGIN_DIR is not set, so no plugins were loaded.           │',
          '│ Serving `_system` admin + /health only — no user types.           │',
          '│ Point it at a directory holding plugins, e.g.:                    │',
          '│   SUBSTRATE_PLUGIN_DIR=/srv/substrate   (with plugins under node_modules) │'
        ]
      : [
          '│ No plugins found — serving `_system` admin + /health only.         │',
          '│ Looked under <SUBSTRATE_PLUGIN_DIR>/node_modules for packages         │',
          '│ declaring a `substrate` manifest, and found none. If you have not     │',
          '│ installed any there yet, that is the next step.                    │'
        ];
  return [
    '',
    '┌─ no plugins ──────────────────────────────────────────────────────┐',
    ...lines,
    '└───────────────────────────────────────────────────────────────────┘',
    ''
  ].join('\n');
}

/**
 * Loud banner emitted at boot whenever the substrate is running on memory
 * mode, so operators can't accidentally believe their data is durable.
 *
 * `byDefault` is `true` when `SUBSTRATE_DATABASE_URL` was unset and we fell back to
 * memory; `false` when the operator chose memory explicitly.
 */
export function memoryStoreBanner(byDefault: boolean): string {
  const reason = byDefault
    ? 'SUBSTRATE_DATABASE_URL not set — defaulting to in-memory store.'
    : 'SUBSTRATE_DATABASE_URL=memory — running with in-memory store.';
  return [
    '',
    '┌─ memory mode ─────────────────────────────────────────────────────┐',
    `│ ${reason.padEnd(65)} │`,
    '│ Data is NOT persisted; all writes vanish on restart.              │',
    '│ For durable storage, set SUBSTRATE_DATABASE_URL to a postgres:// URL, e.g.:  │',
    "│   SUBSTRATE_DATABASE_URL='postgres://substrate:substrate@localhost:5432/substrate'       │",
    '└───────────────────────────────────────────────────────────────────┘',
    ''
  ].join('\n');
}

/**
 * The knob block — every defaulted knob, its effective value, and whether
 * that value came from the operator or from the default. Sorted by env var
 * and column-aligned so two hosts' blocks can be `diff`ed.
 *
 * `—` is an effective value of null: off, or deferred to a layer further down
 * (Fastify's 1 MiB body cap, the engine's 24h idempotency TTL). Every knob
 * appears whether set or not.
 */
export function knobsBanner(knobs: ConfigReport): string {
  const rows = Object.values(knobs).sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.env.length));
  const lines = rows.map((r) => {
    const value = r.value === null ? '—' : String(r.value);
    return `  ${r.env.padEnd(width)}  ${value.padEnd(14)}  ${r.source}`;
  });
  return ['knobs (effective value, source):', ...lines, ''].join('\n');
}
