/**
 * The shipped datasets declare exactly what the validator recognises.
 *
 * Both datasets declare `fullBuiltinOperators()` from `@mnmal-ai/substrate-filter`,
 * so agreement is structural for the shipped pair. This pins a deliberate
 * narrowing (a dataset overriding one kind) so it fails loudly: because
 * `effectiveFilterOperators` intersects the two sides and publishes the
 * result, a dataset that stopped declaring an operator would otherwise narrow
 * the published contract with no error anywhere. Keep the gate:
 * `capabilities.operators` is the substrate's own declaration.
 *
 * The operator universe is scraped from `builtin-operators.ts` rather than
 * typed out, so a widened allowlist enters it automatically and a dataset that
 * failed to follow fails here. Only the third case depends on the scrape.
 *
 * The universe comes from substrate-filter's SOURCE while the datasets and the
 * intersection come from BUILT output. Under turbo (`test` dependsOn `^build`)
 * they match; running vitest directly after an edit without rebuilding
 * compares new source against a stale dist.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectiveFilterOperators } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset } from '@mnmal-ai/substrate-dataset-pg';
import type { FieldKind, FilterCapabilities } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const FILTER_SRC = fileURLToPath(
  new URL('../../../packages/substrate-filter/src/builtin-operators.ts', import.meta.url)
);

/** `export const NUMBER_OPS: readonly string[] = [...]`, including the multi-line ones. */
const OPS_LIST = /export const (\w+_OPS)[^=]*=\s*\[([\s\S]*?)\]/g;

/**
 * Every operator the canonical builtin lists mention, and the name of each
 * list they came from. The names are returned so a list that appears or
 * disappears is visible here as a change rather than absorbed silently into
 * the universe.
 */
function scrapeBuiltinOperators(): { names: string[]; operators: string[] } {
  const src = readFileSync(FILTER_SRC, 'utf8');
  const names: string[] = [];
  const operators = new Set<string>();
  for (const [, name, body] of src.matchAll(OPS_LIST)) {
    names.push(name as string);
    for (const [, op] of (body as string).matchAll(/'([^']+)'/g)) operators.add(op as string);
  }
  return { names: names.sort(), operators: [...operators].sort() };
}

const SCRAPED = scrapeBuiltinOperators();

/** A declaration claiming every scraped operator on every kind. */
const UNIVERSE: FilterCapabilities = {
  operators: {
    'scalar.number': SCRAPED.operators,
    'scalar.string': SCRAPED.operators,
    'scalar.boolean': SCRAPED.operators,
    'scalar.date': SCRAPED.operators,
    'scalar.json': SCRAPED.operators,
    crossRef: SCRAPED.operators,
    list: SCRAPED.operators
  },
  orderBy: true,
  cursor: true
};

/**
 * The validator's builtin set per kind, recovered through the only public
 * window onto it. Intersecting a declaration of everything leaves exactly what
 * the validator recognises, so nothing here names an operator as expected.
 */
const BUILTIN = effectiveFilterOperators(UNIVERSE);
const KINDS = Object.keys(BUILTIN) as FieldKind[];

function sortedDeclaration(capabilities: FilterCapabilities): Record<FieldKind, string[]> {
  const out = {} as Record<FieldKind, string[]>;
  for (const kind of KINDS) out[kind] = [...capabilities.operators[kind]].sort();
  return out;
}

// Never queried — only stored on the instance, handed to a WeakMap for the
// substrate id, and wrapped by PgShortIdStore, whose constructor is a field
// assignment. postgres.js connects lazily, so no server is involved and this
// suite stays ungated.
const sql: Sql = postgres('postgres://unused@127.0.0.1:1/unused');

const DATASETS: Array<[string, FilterCapabilities]> = [
  ['memory', new MemoryDataset({ namespace: 'parity' }).capabilities],
  ['pg', new PgDataset({ namespace: 'parity', sql }).capabilities]
];

describe('the shipped datasets and the validator agree on the operator allowlist', () => {
  afterAll(async () => {
    await sql.end();
  });

  it('scrapes the validator, and says so when the sets move', async () => {
    // A scrape that matched nothing would make the universe empty, every
    // builtin set empty, and the third case below pass by comparing two empty
    // maps. The count and the anchors are what stop that reading as agreement.
    expect(SCRAPED.names).toEqual([
      'BOOLEAN_OPS',
      'CROSSREF_OPS',
      'JSON_PATH_OPS',
      'LIST_OPS',
      'NUMBER_OPS',
      'STRING_OPS'
    ]);
    expect(SCRAPED.operators).toEqual(expect.arrayContaining(['eq', 'contains', 'has', 'between']));

    // And the recovered sets must be shaped like the validator's, or the
    // intersection window is not doing what the comment above claims.
    expect(BUILTIN['scalar.json']).toEqual(expect.arrayContaining(['eq', 'gt', 'has']));
    expect(BUILTIN.crossRef.length).toBeGreaterThan(0);
    expect(BUILTIN['scalar.string'].length).toBeGreaterThan(BUILTIN.crossRef.length);
  });

  it('declares the same map as each other', async () => {
    // The cheapest failure to diagnose: one dataset edited and the other not.
    // Implied by the last case, but it survives a broken scrape and it names
    // the discrepancy directly instead of reporting two separate drifts.
    const [[, memory], [, pg]] = DATASETS as [
      [string, FilterCapabilities],
      [string, FilterCapabilities]
    ];

    expect(pg.operators).toEqual(memory.operators);
  });

  for (const [name, capabilities] of DATASETS) {
    it(`${name}: claims nothing the validator will refuse`, async () => {
      // Needs no universe, so this holds even if the scrape above breaks
      // entirely. `effectiveFilterOperators` can only subtract, so leaving the
      // declaration unchanged is exactly the statement that every operator in
      // it is one the validator recognises.
      expect(effectiveFilterOperators(capabilities)).toEqual(sortedDeclaration(capabilities));
    });

    it(`${name}: declares everything the validator recognises`, async () => {
      // The other direction, and the one that needs the scrape: a dataset
      // dropping an operator narrows the published contract with no error
      // anywhere. Equality rather than a superset check, because a shipped
      // dataset declaring MORE than the validator knows about is the first
      // case failing too, and the pair should disagree loudly.
      expect(sortedDeclaration(capabilities)).toEqual(BUILTIN);
    });
  }
});
