#!/usr/bin/env node
/**
 * substrate-toolchain-check — compare a repo's toolchain with the fleet's.
 *
 *   substrate-toolchain-check [--strict] [--fix] [--root <dir>] [--json]
 *
 * The fleet's versions are `toolchain.json` beside this file, generated from
 * mnmal-ai/substrate's own config at release. So a repo is held to the
 * substrate-config version it depends on, and moving the fleet is a substrate-config
 * bump in each repo rather than N hand edits.
 *
 * Checks only what the repo actually uses: a catalog entry it does not have,
 * or an action it does not call, is not drift. Zero dependencies on purpose,
 * so it runs whatever toolchain the repo is on — including a drifted one.
 *
 * `--fix` rewrites what it finds in place, before checking: catalog entries,
 * pnpm (packageManager + mise), engines.node, the Biome schema and Actions
 * pins. Edits are textual, so formatting survives. It never adds a field a
 * repo does not have. Run `pnpm install` afterwards when the catalog moved.
 *
 * Exit 0 when aligned, or when drift is found without --strict (warn mode);
 * 1 when drift is found with --strict.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = resolve(at >= 0 ? (args[at + 1] ?? '.') : '.');
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const fix = args.includes('--fix');

const fleet = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'toolchain.json'), 'utf8')
);
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);

/** Files `--fix` rewrote, for the report. */
const fixed = [];
/** Rewrite `path` through `edit` when it exists and the edit changes it. */
const rewrite = (path, edit) => {
  const before = read(path);
  if (before === null) return;
  const after = edit(before);
  if (after !== before) {
    writeFileSync(join(root, path), after);
    fixed.push(path);
  }
};

if (fix) {
  rewrite('package.json', (t) =>
    t
      .replace(/("packageManager"\s*:\s*")pnpm@[^"]*(")/, `$1pnpm@${fleet.pnpm}$2`)
      .replace(/("engines"\s*:\s*\{[^}]*?"node"\s*:\s*")[^"]*(")/, `$1${fleet.node.engines}$2`)
  );
  rewrite('mise.toml', (t) => t.replace(/^(\s*pnpm\s*=\s*")[^"]+(")/m, `$1${fleet.pnpm}$2`));
  rewrite('biome.json', (t) => t.replace(/(schemas\/)[\d.]+(\/)/, `$1${fleet.biomeSchema}$2`));
  rewrite('pnpm-workspace.yaml', (t) => {
    let on = false;
    return t
      .split('\n')
      .map((line) => {
        if (/^catalog:\s*$/.test(line)) on = true;
        else if (on && line.trim() !== '' && !line.startsWith(' ')) on = false;
        if (!on) return line;
        const m = /^(\s+["']?)([^"':#]+?)(["']?\s*:\s*["']?)([^"'\s#]+)(.*)$/.exec(line);
        const want = m && fleet.catalog?.[m[2]];
        return want === undefined || want === null ? line : `${m[1]}${m[2]}${m[3]}${want}${m[5]}`;
      })
      .join('\n');
  });
  const wfDir = join(root, '.github/workflows');
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
      rewrite(join('.github/workflows', f), (t) =>
        t.replace(
          /(uses:\s*)([\w./-]+)@([0-9a-f]{40})(\s*#\s*)v[\d.]+/g,
          (whole, pre, action, _sha, gap) => {
            const want = fleet.actions?.[action];
            return want === undefined ? whole : `${pre}${action}@${want.sha}${gap}${want.version}`;
          }
        )
      );
    }
  }
}

/** @type {Array<{ item: string; want: string; have: string | null; ok: boolean }>} */
const rows = [];
const check = (item, want, have) => {
  if (want === undefined || have === null || have === undefined) return;
  rows.push({ item, want: String(want), have: String(have), ok: String(want) === String(have) });
};

// A repo without package.json (holomap is Rust) still has workflow pins to check.
const pkgText = read('package.json');
if (pkgText !== null) {
  const pkg = JSON.parse(pkgText);
  check('engines.node', fleet.node?.engines, pkg.engines?.node ?? '(none)');
  if (typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('pnpm@'))
    check('packageManager pnpm', fleet.pnpm, pkg.packageManager.slice(5).split('+')[0]);
}

const mise = read('mise.toml');
const misePnpm = mise && /^\s*pnpm\s*=\s*"([^"]+)"/m.exec(mise)?.[1];
if (misePnpm) check('mise pnpm', fleet.pnpm, misePnpm);

const biome = read('biome.json');
const schema = biome && /schemas\/([\d.]+)\//.exec(biome)?.[1];
if (schema) check('biome.json $schema', fleet.biomeSchema, schema);

const ws = read('pnpm-workspace.yaml');
if (ws !== null) {
  let on = false;
  for (const line of ws.split('\n')) {
    if (/^catalog:\s*$/.test(line)) {
      on = true;
      continue;
    }
    if (!on) continue;
    if (line.trim() !== '' && !line.startsWith(' ')) break;
    const m = /^\s+["']?([^"':#]+?)["']?\s*:\s*["']?([^"'\s#]+)/.exec(line);
    if (m && fleet.catalog?.[m[1]] !== undefined)
      check(`catalog ${m[1]}`, fleet.catalog[m[1]], m[2]);
  }
}

const wf = join(root, '.github/workflows');
if (existsSync(wf)) {
  const seen = new Set();
  for (const f of readdirSync(wf).filter((x) => /\.ya?ml$/.test(x))) {
    const text = readFileSync(join(wf, f), 'utf8');
    for (const m of text.matchAll(/uses:\s*([\w./-]+)@([0-9a-f]{40})(?:\s*#\s*(v[\d.]+))?/g)) {
      const [, action, sha, version] = m;
      const want = fleet.actions?.[action];
      if (want === undefined || seen.has(`${action}@${sha}`)) continue;
      seen.add(`${action}@${sha}`);
      check(
        `action ${action} (${f})`,
        `${want.version} ${want.sha.slice(0, 7)}`,
        `${version ?? '?'} ${sha.slice(0, 7)}`
      );
    }
  }
}

const drift = rows.filter((r) => !r.ok);
if (fix && !asJson) {
  console.log(
    fixed.length === 0
      ? 'fix: nothing to rewrite'
      : `fix: rewrote ${fixed.join(', ')}${fixed.includes('pnpm-workspace.yaml') ? ' (run pnpm install to update the lockfile)' : ''}`
  );
}
if (asJson) {
  console.log(
    JSON.stringify({ aligned: drift.length === 0, rows, ...(fix ? { fixed } : {}) }, null, 2)
  );
} else {
  for (const r of rows)
    console.log(
      `${r.ok ? '  ok   ' : '  DRIFT'} ${r.item.padEnd(44)} ${r.ok ? r.have : `${r.have}  (fleet: ${r.want})`}`
    );
  console.log(
    drift.length === 0
      ? `aligned with the fleet toolchain (${rows.length} checks)`
      : `${drift.length} of ${rows.length} drift from the fleet toolchain${strict ? '' : ' (warn only; pass --strict to fail)'}`
  );
}
process.exit(drift.length > 0 && strict ? 1 : 0);
