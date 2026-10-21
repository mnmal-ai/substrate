/**
 * Label-catalog drift guard. `check-pr-labels.js` treats Area as an open set,
 * so a package with no label would otherwise pass the hygiene gate silently.
 *
 * Compares every workspace member (`packages/`, `apps/`, `plugins/` holding a
 * `package.json`) against the repo's label list and exits non-zero naming the
 * members with no Area label, with the exact `gh label create` to fix it.
 * One direction only: extra labels (e.g. `repo`) are not drift — only a package nobody can label is.
 *
 * CLI usage (in CI): needs `gh` authenticated (GH_TOKEN) — run from the repo
 * root. Reads nothing from the PR; this is repo state, not PR state.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const WORKSPACE_DIRS = ['packages', 'apps', 'plugins'];
const ORG_PREFIX = '@mnmal-ai/';

/**
 * @param {string} rootDir repo root
 * @returns {string[]} workspace member names without the org prefix, sorted
 */
export function discoverWorkspaceMembers(rootDir) {
  const out = [];
  for (const dir of WORKSPACE_DIRS) {
    const absDir = resolve(rootDir, dir);
    if (!existsSync(absDir)) continue;
    for (const name of readdirSync(absDir).sort()) {
      const pkgFile = resolve(absDir, name, 'package.json');
      if (!existsSync(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      if (typeof pkg.name === 'string') {
        out.push(pkg.name.startsWith(ORG_PREFIX) ? pkg.name.slice(ORG_PREFIX.length) : pkg.name);
      }
    }
  }
  return [...new Set(out)].sort();
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
