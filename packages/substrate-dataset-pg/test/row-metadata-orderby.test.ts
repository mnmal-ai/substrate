/**
 * PG dataset orderBy + cursor pagination on metadata columns.
 *
 * After --finalize, body.createdAt / body.updatedAt are dropped. Any orderBy or
 * cursor that routes to `(body ->> field)` therefore returns undefined order.
 * These tests pin the correct behaviour: metadata fields route to native columns.
 *
 * Critically: rows are written with `_metadata` populated but the `body` never
 * receives `createdAt` / `updatedAt` keys — mimicking the post-finalize state.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import type { ActorIdentity, RowMetadata } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function meta(at: string, by?: ActorIdentity): RowMetadata {
  const actor: ActorIdentity = by ?? { kind: 'agent', id: 'a1' };
  return { createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
}

describe.skipIf(!POSTGRES_URL)(
  'PG dataset orderBy + cursor on metadata columns (Agent E Finding 1)',
  () => {
    let sql: Sql;
    let ds: PgDataset;

    beforeEach(async () => {
      sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
      await sql`DROP TABLE IF EXISTS rows CASCADE`;
      await runMigrations(sql, { force: true });
      ds = new PgDataset({ namespace: 'test', sql });
    });

    afterEach(async () => {
      await sql.end();
    });

    // -----------------------------------------------------------------------
    // orderBy
    // -----------------------------------------------------------------------
    describe('orderBy on metadata columns', () => {
      beforeEach(async () => {
        // Write 3 rows with distinct createdAt/updatedAt. Body has NO timestamp keys —
        // this simulates the post-finalize state where body keys were dropped.
        await ds.write('Thing', [
          { id: 'r1', name: 'first', _metadata: meta('2026-04-25T00:00:00.000Z') },
          { id: 'r2', name: 'second', _metadata: meta('2026-04-25T01:00:00.000Z') },
          { id: 'r3', name: 'third', _metadata: meta('2026-04-25T02:00:00.000Z') }
        ]);
        // Verify body does not carry timestamp keys (finalize precondition)
        const rows = await sql<{ id: string; body: Record<string, unknown> }[]>`
          SELECT id, body FROM rows WHERE namespace = 'test' AND type = 'Thing'
          ORDER BY id
        `;
        for (const row of rows) {
          expect(row.body.createdAt).toBeUndefined();
          expect(row.body.updatedAt).toBeUndefined();
        }
      });

      it('orderBy createdAt desc returns rows in column-sorted order (r3, r2, r1)', async () => {
        const result = await ds.read('Thing', {
          orderBy: [{ createdAt: 'desc' }]
        });
        expect(result.rows.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
      });

      it('orderBy createdAt asc returns rows in column-sorted order (r1, r2, r3)', async () => {
        const result = await ds.read('Thing', {
          orderBy: [{ createdAt: 'asc' }]
        });
        expect(result.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
      });

      it('orderBy updatedAt desc returns rows in column-sorted order', async () => {
        // Write a row with different updatedAt to distinguish from createdAt
        await ds.write('Thing', [
          {
            id: 'r4',
            name: 'fourth',
            _metadata: {
              createdAt: '2026-04-25T00:00:00.000Z',
              updatedAt: '2026-04-25T03:00:00.000Z',
              createdBy: { kind: 'agent', id: 'a1' },
              updatedBy: { kind: 'agent', id: 'a1' }
            }
          }
        ]);
        const result = await ds.read('Thing', {
          orderBy: [{ updatedAt: 'desc' }]
        });
        // r4 has the latest updatedAt
        expect(result.rows[0]?.id).toBe('r4');
      });

      it('orderBy updatedAt asc returns rows in column-sorted order', async () => {
        const result = await ds.read('Thing', {
          orderBy: [{ updatedAt: 'asc' }]
        });
        expect(result.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
      });
    });

    // -----------------------------------------------------------------------
    // Cursor pagination on createdAt
    // -----------------------------------------------------------------------
    describe('cursor pagination on createdAt', () => {
      beforeEach(async () => {
        // Write 5 rows with distinct timestamps for pagination testing
        await ds.write('Thing', [
          { id: 'p1', name: 'page1', _metadata: meta('2026-04-25T00:00:00.000Z') },
          { id: 'p2', name: 'page2', _metadata: meta('2026-04-25T01:00:00.000Z') },
          { id: 'p3', name: 'page3', _metadata: meta('2026-04-25T02:00:00.000Z') },
          { id: 'p4', name: 'page4', _metadata: meta('2026-04-25T03:00:00.000Z') },
          { id: 'p5', name: 'page5', _metadata: meta('2026-04-25T04:00:00.000Z') }
        ]);
      });

      it('cursor pagination on createdAt returns consistent pages without overlap or gap', async () => {
        const pageSize = 2;

        // Page 1
        const page1 = await ds.read('Thing', {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          limit: pageSize
        });
        expect(page1.rows.map((r) => r.id)).toEqual(['p1', 'p2']);

        // Page 2 — use cursor from page 1
        expect(page1.nextCursor).toBeDefined();
        const page2 = await ds.read('Thing', {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          limit: pageSize,
          cursor: page1.nextCursor!
        });
        expect(page2.rows.map((r) => r.id)).toEqual(['p3', 'p4']);

        // Page 3 — use cursor from page 2
        expect(page2.nextCursor).toBeDefined();
        const page3 = await ds.read('Thing', {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          limit: pageSize,
          cursor: page2.nextCursor!
        });
        expect(page3.rows.map((r) => r.id)).toEqual(['p5']);
        expect(page3.nextCursor).toBeUndefined();

        // Verify no overlap or gap — full page union should be all 5 rows in order
        const allIds = [
          ...page1.rows.map((r) => r.id),
          ...page2.rows.map((r) => r.id),
          ...page3.rows.map((r) => r.id)
        ];
        expect(allIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
      });

      it('cursor pagination on createdAt desc returns pages in reverse order', async () => {
        const pageSize = 2;

        const page1 = await ds.read('Thing', {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          limit: pageSize
        });
        expect(page1.rows.map((r) => r.id)).toEqual(['p5', 'p4']);

        expect(page1.nextCursor).toBeDefined();
        const page2 = await ds.read('Thing', {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          limit: pageSize,
          cursor: page1.nextCursor!
        });
        expect(page2.rows.map((r) => r.id)).toEqual(['p3', 'p2']);
      });
    });
  }
);
