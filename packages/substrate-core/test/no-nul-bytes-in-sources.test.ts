/**
 * Repo-wide guard: no raw NUL byte may appear in a TypeScript source.
 *
 * A single NUL makes `grep`/`rg` classify the file as BINARY, so every search
 * over it returns NOTHING — silently, with exit status 1 and no diagnostic. The
 * failure mode is not "search is noisy", it is "search lies": a pattern that IS
 * present reports as absent.
 *
 * NUL is still perfectly legal *as a value* — `callerDedupComponent` uses one
 * deliberately to make the anonymous idempotency bucket unspoofable. Write it as
 * a unicode escape (backslash-u-0000), which is runtime-identical and keeps the file plain
 * text. This test enforces the encoding, never the value.
 *
 * Hosted in substrate-core, but the scan is
 * repo-wide — turbo runs suites per package, so a cross-cutting hygiene check
 * needs one package to own it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCAN_ROOTS = ['packages', 'apps', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.git']);

function* walkTsFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Root absent in a partial checkout — nothing to scan.
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      yield full;
    }
  }
}

describe('source hygiene', () => {
  it('contains no raw NUL bytes in any TypeScript source', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkTsFiles(join(REPO_ROOT, root))) {
        if (readFileSync(file).includes(0)) offenders.push(relative(REPO_ROOT, file));
      }
    }
    // Named explicitly so a failure tells you the fix, not just the fact.
    expect(
      offenders,
      `Raw NUL byte(s) found. grep/rg treat these files as binary and silently ` +
        `return no matches. Replace the literal byte with the '\\u0000' escape — ` +
        `runtime-identical, and the file stays searchable.`
    ).toEqual([]);
  });
});
