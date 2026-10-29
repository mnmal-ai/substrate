/**
 * migrate-store's verification (pg-gated): a real copied pair in both source
 * layouts, then tampering on either side.
 */

import type { PgDataset } from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CopyResult, copyStore } from '../src/admin/migrate-store/copy.js';
import {
  fingerprint,
  readCopyState,
  type VerifyOptions,
  verifyStore
} from '../src/admin/migrate-store/verify.js';
import { buildDeferredIndexes } from '../src/serve/wiring.js';
import { openPair, type Pair, POSTGRES_URL, uuid } from './_fixtures/migrate-store.js';

for (const sourceLayout of ['legacy', 'partitioned'] as const) {
  describe.skipIf(!POSTGRES_URL)(`verifyStore from a ${sourceLayout} source (pg)`, () => {
    let pair: Pair;
    let srcSql: Sql;
    let tgtSql: Sql;
    let result: CopyResult;

    beforeEach(async () => {
      // Different session zones per side, as two clusters may have.
      pair = await openPair(sourceLayout, { src: 'America/Los_Angeles', tgt: 'Pacific/Auckland' });
      ({ srcSql, tgtSql } = pair);
      result = await copyStore(srcSql, pair.boot, pair.plan, {
        batchRows: 100,
        onProgress: () => {}
      });
      // The command builds the non-unique indexes before it verifies.
      await buildDeferredIndexes(result.target.engine, result.target.datasets);
      // A copy plus index builds takes up to a minute when the whole suite runs at once.
    }, 240_000);

    afterEach(async () => {
      await result.target.close();
      await pair.close();
    });

    const opts = (o: Partial<VerifyOptions> = {}): VerifyOptions => ({
      keptSeeds: result.keptSeeds,
      defaulted: result.defaulted,
      tables: pair.plan.tables.map((t) => t.name),
      fullChecksum: false,
      sampleRows: 1000,
      partitionBudget: 500,
      storageReport: (r) => (result.target.dataset as PgDataset).storageReport(r),
      ...o
    });
    const markerPresent = async () =>
      (await tgtSql`SELECT to_regclass('substrate_migrate_store_progress') AS r`)[0]?.r !== null;
    const verify = (o?: Partial<VerifyOptions>) => verifyStore(srcSql, tgtSql, opts(o));

    it('passes on a faithful copy and clears the in-progress marker', async () => {
      expect(await markerPresent()).toBe(true);
      expect(result.defaulted).toEqual([{ namespace: 'retired', type: 'Old' }]);
      expect(await verify({ fullChecksum: true })).toEqual({ ok: true, mismatches: [] });
      expect(await markerPresent()).toBe(false);
    });

    it('reads the kept seeds and defaulted types back from the target', async () => {
      const state = await readCopyState(result.target);
      expect(state).toEqual({
        keptSeeds: result.keptSeeds,
        defaulted: result.defaulted,
        tables: pair.plan.tables.map((t) => t.name).sort()
      });
      expect(await verify(state)).toEqual({ ok: true, mismatches: [] });
    });

    it('catches a dropped row', async () => {
      await tgtSql`DELETE FROM rows WHERE id = ${uuid(3)}`;
      const r = await verify();
      expect(r.ok).toBe(false);
      expect(r.mismatches.map((m) => [m.check, m.type])).toContainEqual(['count', 'Invite']);
      expect(await markerPresent()).toBe(true);
    });

    it('catches an altered column in the sample', async () => {
      await tgtSql`UPDATE rows SET body = '{"code":"changed"}' WHERE id = ${uuid(3)}`;
      const r = await verify();
      expect(r.ok).toBe(false);
      expect(r.mismatches).toEqual([
        expect.objectContaining({ check: 'sample', namespace: '_system', type: 'Invite' })
      ]);
      expect(await markerPresent()).toBe(true);
    });

    it('catches a changed shortId', async () => {
      await tgtSql`UPDATE short_ids SET short_id = 99 WHERE row_id = ${uuid(1)}`;
      const r = await verify();
      expect(r.ok).toBe(false);
      expect(r.mismatches.map((m) => [m.check, m.type])).toContainEqual(['short_ids', 'Key']);
      expect(await markerPresent()).toBe(true);
    });

    it('catches a tampered edge target', async () => {
      await tgtSql`UPDATE edges SET to_id = ${uuid(99)} WHERE id = ${uuid(10)}`;
      const r = await verify();
      expect(r.mismatches.map((m) => [m.check, m.type])).toContainEqual(['edges', 'Key']);
      expect(await markerPresent()).toBe(true);
    });

    it('catches a tampered visible_seqs row', async () => {
      await tgtSql`UPDATE visible_seqs SET last_seq = 99`;
      const r = await verify();
      expect(r.mismatches).toEqual([expect.objectContaining({ check: 'table' })]);
      expect(r.mismatches[0]?.detail).toMatch(/^visible_seqs:/);
    });

    it('catches a tampered recall cluster label', async () => {
      await tgtSql`UPDATE recall_clusters SET label = 'changed' WHERE id = 'c2'`;
      const r = await verify();
      expect(r.mismatches).toEqual([expect.objectContaining({ check: 'table' })]);
      expect(r.mismatches[0]?.detail).toMatch(/^recall_clusters:/);
    });

    it('fingerprints a set independent of order, and differs by one row', async () => {
      const ids = ['a', 'b', 'c', 'd'];
      expect(await fingerprint(srcSql, ids)).toBe(await fingerprint(srcSql, [...ids].reverse()));
      expect(await fingerprint(srcSql, ids)).not.toBe(await fingerprint(srcSql, ids.slice(1)));
      expect(await fingerprint(srcSql, ids)).not.toBe(
        await fingerprint(srcSql, ['a', 'b', 'c', 'e'])
      );
    });

    it('fails when a declared type has rows in the DEFAULT partition', async () => {
      const r = await verify({ defaulted: [] });
      expect(r.ok).toBe(false);
      expect(r.mismatches).toEqual([
        expect.objectContaining({ check: 'storage', namespace: 'retired', type: 'Old' })
      ]);
      expect(await markerPresent()).toBe(true);
    });
  });
}
