/**
 * The CLI `--help` env block must not drift from the code.
 *
 * It cannot check that a description is *true*; it checks the mechanizable
 * half: every environment variable the help NAMES must actually be read
 * somewhere in the source. That catches a var renamed or deleted while its
 * help line lives on.
 *
 * "Read" means an actual property access, not a substring hit: a comment or
 * a doc string mentioning the name must not vouch for code that no longer
 * reads it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

/** Source trees that legitimately own a `serve`-time environment variable. */
const SRC_DIRS = [
  'apps/substrate/src',
  'packages/substrate-compose/src',
  'packages/substrate-dataset-pg/src',
  'plugins/substrate-recall/src'
];

function collectSources(dir: string): string {
  let out = '';
  let entries: Array<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return '';
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out += collectSources(full);
    } else if (full.endsWith('.ts')) {
      out += readFileSync(full, 'utf8');
    }
  }
  return out;
}

describe('CLI help env block', () => {
  it('names only environment variables the code actually reads', () => {
    const helpSource = readFileSync(join(REPO_ROOT, 'apps/substrate/src/cli.ts'), 'utf8');
    const helpBlock = helpSource.slice(helpSource.indexOf('Environment for'));

    const named = [...new Set(helpBlock.match(/\bSUBSTRATE_[A-Z0-9_]+\b/g) ?? [])];
    // Guard the guard: if the extraction breaks, an empty list would make this
    // test vacuously green — exactly the failure mode it exists to prevent.
    expect(named.length).toBeGreaterThan(5);

    const sources = SRC_DIRS.map((d) => collectSources(join(REPO_ROOT, d))).join('');
    expect(sources.length).toBeGreaterThan(1000);

    // A read is `env.VAR`, `env['VAR']`, or `process.env.VAR` — never a bare
    // mention. See the header: matching raw text lets a comment vouch for code
    // that no longer exists.
    const isRead = (v: string): boolean =>
      new RegExp(`env\\s*(?:\\.\\s*${v}\\b|\\[\\s*['"\`]${v}['"\`]\\s*\\])`).test(sources);

    const unread = named.filter((v) => !isRead(v));
    expect(
      unread,
      'the help block names these but nothing reads them — either the help is ' +
        'stale, or the var is read in a way this pattern does not recognise ' +
        '(widen `isRead` deliberately, do not fall back to a substring match)'
    ).toEqual([]);
  });

  it('does not claim an NL-provider variable configures the recall embedder', () => {
    const helpSource = readFileSync(join(REPO_ROOT, 'apps/substrate/src/cli.ts'), 'utf8');
    const helpBlock = helpSource.slice(helpSource.indexOf('Environment for'));

    // `SUBSTRATE_OLLAMA_URL` may appear under SUBSTRATE_NL_PROVIDER, but never as the
    // embedder's knob, which lives in substrate-recall.config.json.
    const embedderClaim = /SUBSTRATE_OLLAMA_URL[^\n]*embedder/i.test(helpBlock);
    expect(embedderClaim).toBe(false);
  });
});
