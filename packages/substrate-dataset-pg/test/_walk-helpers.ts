/**
 * Differential reads for walk suites: the memory dataset's reference evaluator
 * is the oracle, and each helper asserts pg returns what memory does.
 */

import type { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { ReadParams, ReadResult, Row, WhereClause } from '@mnmal-ai/substrate-types';
import { expect } from 'vitest';
import type { PgDataset } from '../src/index.js';

/** A row without the columns only one dataset fills (`_metadata`, `shortId`). */
export const strip = (r: Row): Row => {
  const { _metadata: _m, shortId: _s, ...rest } = r;
  return rest as Row;
};

/**
 * Comparers over the datasets `pair()` returns at call time (suites reload
 * memory per fixture); `label` maps a row id to its fixture name.
 */
export function walkComparers(
  pair: () => { pg: PgDataset; mem: MemoryDataset },
  label: (id: string) => string
) {
  /** The fixture names of the `type` rows matching `where`, asserting pg and memory agree. */
  async function both(type: string, where: WhereClause, includeDeleted = false): Promise<string[]> {
    const read = async (ds: PgDataset | MemoryDataset) =>
      (await ds.read(type, { where, ...(includeDeleted ? { includeDeleted } : {}) })).rows
        .map((r) => label(String(r.id)))
        .sort();
    const want = await read(pair().mem);
    expect(await read(pair().pg), JSON.stringify(where)).toEqual(want);
    return want;
  }

  /** The rows `params` reads from `type`, asserting pg and memory agree on every key. */
  async function same(type: string, params: ReadParams): Promise<Row[]> {
    const read = async (ds: PgDataset | MemoryDataset) =>
      (await ds.read(type, params)).rows.map(strip);
    const want = await read(pair().mem);
    expect(await read(pair().pg), JSON.stringify(params)).toEqual(want);
    return want;
  }

  /** The whole-result answer `params` reads from `type`, asserting pg and memory agree. */
  async function sameResult(type: string, params: ReadParams): Promise<ReadResult> {
    const pick = ({ rows, hasMore, count, groups, truncated }: ReadResult) =>
      ({ rows, hasMore, count, groups, truncated }) as ReadResult;
    const want = pick(await pair().mem.read(type, params));
    expect(pick(await pair().pg.read(type, params)), JSON.stringify(params)).toEqual(want);
    return want;
  }

  return { both, same, sameResult };
}
