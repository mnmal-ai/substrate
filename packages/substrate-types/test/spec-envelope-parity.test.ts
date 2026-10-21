import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The spec's §7.0 envelope block and `PackEnvelope` are the same list
 * written twice.
 *
 * Both sides are parsed from source here rather than compared against a
 * hand-kept list, because a third copy would drift the same way. The test
 * fails on ANY divergence, including a key added to the type and not the spec.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SPEC = `${REPO_ROOT}/docs/substrate-from-first-principles.md`;
const SCHEMA_SRC = `${REPO_ROOT}/packages/substrate-types/src/schema.ts`;

/**
 * Pull the top-level property names out of one `interface Name { ... }` body.
 * Depth-tracking keeps nested object literals (the inline shapes of
 * `_pagination`, `_completeness`, `errors`) from contributing their inner
 * keys, and only lines at depth 1 are considered.
 */
function interfaceKeys(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`);
  if (start === -1) throw new Error(`interface ${name} not found`);

  const keys: string[] = [];
  let depth = 0;
  for (const rawLine of source.slice(start).split('\n')) {
    const line = rawLine.trim();
    if (depth === 1) {
      // `key: type` / `key?: type` at the top level of the body
      const match = /^([A-Za-z_][\w]*)\??\s*:/.exec(line);
      if (match?.[1] !== undefined) keys.push(match[1]);
    }
    depth += (line.match(/[{[]/g) ?? []).length;
    depth -= (line.match(/[}\]]/g) ?? []).length;
    if (depth === 0 && keys.length > 0) break;
  }
  return keys;
}

describe('§7.0 envelope parity — spec vs PackEnvelope', () => {
  it('the spec lists exactly the keys the type declares, in the same order', () => {
    const specKeys = interfaceKeys(readFileSync(SPEC, 'utf8'), 'PackEnvelope');
    const typeKeys = interfaceKeys(readFileSync(SCHEMA_SRC, 'utf8'), 'PackEnvelope');

    expect(typeKeys.length).toBeGreaterThan(0);
    expect(specKeys).toEqual(typeKeys);
  });

  it('the spec lists exactly the keys Schema declares', () => {
    const specKeys = interfaceKeys(readFileSync(SPEC, 'utf8'), 'Schema');
    const typeKeys = interfaceKeys(readFileSync(SCHEMA_SRC, 'utf8'), 'Schema');

    expect(typeKeys.length).toBeGreaterThan(0);
    expect(specKeys).toEqual(typeKeys);
  });

  it('names both non-fatal sidecars and their absent-means-nothing contract', () => {
    const spec = readFileSync(SPEC, 'utf8');

    // The contract is the load-bearing half: a consumer that treats either
    // sidecar as an error starts failing on reads that succeeded.
    expect(spec).toContain('absence means nothing to report');
    expect(spec).toContain('unknownProjectionFields');
    expect(spec).toContain('deliberately NOT `errors`');
  });
});
