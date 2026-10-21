/**
 * Label-catalog drift guard. `check-pr-labels.js` treats Area as an open set,
 * so a package with no label would otherwise pass the hygiene gate silently.
 *
 * Compares every workspace member (a `package.json` or Cargo `[package]` under
 * `packages/`, `apps/`, `plugins/` or `crates/`, plus a root crate and `npm/`)
 * against the repo's label list and exits non-zero naming the members with no
 * Area label, with the exact `gh label create` to fix it.
 * One direction only: extra labels (e.g. `repo`) are not drift — only a package nobody can label is.
 *
 * CLI usage (in CI): needs `gh` authenticated (GH_TOKEN) — run from the repo
 * root. Reads nothing from the PR; this is repo state, not PR state.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const WORKSPACE_DIRS = ['packages', 'apps', 'plugins', 'crates'];
// Single-directory members, with the manifests that name them. The root counts
// only as a Cargo crate: its package.json is the workspace itself.
const SINGLE_MEMBERS = [
  ['.', ['Cargo.toml']],
  ['npm', ['package.json', 'Cargo.toml']]
];
const ORG_PREFIX = '@mnmal-ai/';

/**
 * @param {string} rootDir repo root
 * @returns {string[]} workspace member names without the org prefix, sorted
 */
export function discoverWorkspaceMembers(rootDir) {
  const out = [];
  const add = (dir, manifests) => {
    const name = memberName(dir, manifests);
    if (name !== undefined)
      out.push(name.startsWith(ORG_PREFIX) ? name.slice(ORG_PREFIX.length) : name);
  };
  for (const dir of WORKSPACE_DIRS) {
    const absDir = resolve(rootDir, dir);
    if (!existsSync(absDir)) continue;
    for (const name of readdirSync(absDir).sort())
      add(resolve(absDir, name), ['package.json', 'Cargo.toml']);
  }
  for (const [dir, manifests] of SINGLE_MEMBERS) add(resolve(rootDir, dir), manifests);
  return [...new Set(out)].sort();
}

/** The first manifest's package name, or undefined when none names one. */
function memberName(dir, manifests) {
  for (const manifest of manifests) {
    const file = resolve(dir, manifest);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const name = manifest === 'package.json' ? JSON.parse(text).name : cargoPackageName(text);
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** `name` from a Cargo.toml's `[package]` table; a workspace-only manifest has none. */
function cargoPackageName(toml) {
  let inPackage = false;
  for (const line of toml.split('\n')) {
    const header = line.trim();
    if (header.startsWith('[')) inPackage = header === '[package]';
    else if (inPackage) {
      const m = /^name\s*=\s*"([^"]+)"/.exec(header);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * @param {{ workspaceMembers: string[], labelNames: string[] }} args
 * @returns {string[]} members with no matching label, sorted
 */
export function findMissingAreaLabels({ workspaceMembers, labelNames }) {
  const labels = new Set(labelNames);
  return workspaceMembers.filter((m) => !labels.has(m)).sort();
}

function listRepoLabels() {
  const raw = execFileSync('gh', ['label', 'list', '--json', 'name', '--limit', '200'], {
    encoding: 'utf8'
  });
  return JSON.parse(raw).map((l) => l.name);
}

function main() {
  const rootDir = process.argv[2] ?? process.cwd();
  const members = discoverWorkspaceMembers(rootDir);
  const missing = findMissingAreaLabels({
    workspaceMembers: members,
    labelNames: listRepoLabels()
  });
  if (missing.length === 0) {
    process.stdout.write(
      `✅ label catalog OK — all ${members.length} workspace members have an Area label.\n`
    );
    return;
  }
  process.stdout.write('❌ label catalog drift — workspace members with no Area label:\n');
  for (const m of missing) {
    process.stdout.write(`  • ${m}\n`);
    process.stdout.write(
      `    gh label create ${m} --color 1d76db --description "<one line, see sibling labels>"\n`
    );
  }
  process.exitCode = 1;
}

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
