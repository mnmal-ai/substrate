/**
 * PG dataset row-metadata round-trip tests.
 *
 * Covers write path (6 columns populated), read path (_metadata projected),
 * and filter classifier (column-routed WHERE vs body->> extraction).
 *
 * Skipped when POSTGRES_URL is absent.
 * Uses beforeEach DROP TABLE so each group starts from a clean schema.
 */

import {
  type ActorIdentity,
  normaliseMetadataWhere,
  type RowMetadata,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function metadata(at: string, by: ActorIdentity): RowMetadata {
  return { createdAt: at, updatedAt: at, createdBy: by, updatedBy: by };
}

describe.skipIf(!POSTGRES_URL)('PG dataset row metadata', () => {
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

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------
  describe('Write path', () => {
    it('populates 6 metadata columns on insert', async () => {
      await ds.write('Thing', [
        {
          id: 't1',
          name: 'x',
          _metadata: metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' })
        }
      ]);
      const cols = await sql<
        {
          created_at: Date | null;
          updated_at: Date | null;
          created_by_kind: string | null;
          created_by_id: string | null;
          updated_by_kind: string | null;
          updated_by_id: string | null;
          body: Record<string, unknown>;
        }[]
      >`
        SELECT created_at, updated_at, created_by_kind, created_by_id, updated_by_kind, updated_by_id, body
        FROM rows WHERE namespace = 'test' AND type = 'Thing' AND id = 't1'
      `;
      expect(cols[0]?.created_at?.toISOString()).toBe('2026-04-25T00:00:00.000Z');
      expect(cols[0]?.updated_at?.toISOString()).toBe('2026-04-25T00:00:00.000Z');
      expect(cols[0]?.created_by_kind).toBe('agent');
      expect(cols[0]?.created_by_id).toBe('a1');
      expect(cols[0]?.updated_by_kind).toBe('agent');
      expect(cols[0]?.updated_by_id).toBe('a1');
      // Body should NOT contain _metadata (single source of truth)
      expect(cols[0]?.body._metadata).toBeUndefined();
      expect(cols[0]?.body.createdAt).toBeUndefined();
    });

    it('auto-fills created_at when _metadata is absent; identity columns remain null', async () => {
      const before = new Date();
      await ds.write('Thing', [{ id: 't2', name: 'legacy' }]);
      const after = new Date();
      const cols = await sql<{ created_at: Date | null; created_by_kind: string | null }[]>`
        SELECT created_at, created_by_kind FROM rows WHERE id = 't2'
      `;
      expect(cols[0]?.created_at).not.toBeNull();
      expect(cols[0]?.created_at?.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(cols[0]?.created_at?.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(cols[0]?.created_by_kind).toBeNull();
    });

    it('upsert merge preserves metadata columns on second write', async () => {
      const meta = metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' });
      await ds.write('Thing', [{ id: 't3', name: 'first', _metadata: meta }]);
      // Second write carries updated metadata
      const meta2: RowMetadata = {
        createdAt: '2026-04-25T00:00:00.000Z',
        updatedAt: '2026-04-25T01:00:00.000Z',
        createdBy: { kind: 'agent', id: 'a1' },
        updatedBy: { kind: 'agent', id: 'a2' }
      };
      await ds.write('Thing', [{ id: 't3', name: 'second', _metadata: meta2 }]);
      const cols = await sql<{ updated_at: Date | null; updated_by_id: string | null }[]>`
        SELECT updated_at, updated_by_id FROM rows WHERE id = 't3'
      `;
      expect(cols[0]?.updated_at?.toISOString()).toBe('2026-04-25T01:00:00.000Z');
      expect(cols[0]?.updated_by_id).toBe('a2');
    });
  });

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------
  describe('Read path', () => {
    it('projects _metadata from columns on read', async () => {
      const meta = metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' });
      await ds.write('Thing', [{ id: 't4', name: 'x', _metadata: meta }]);
      const result = await ds.read('Thing', {});
      const row = result.rows.find((r) => r.id === 't4');
      expect(row?._metadata).toEqual(meta);
    });

    it('raw write with no opts auto-fills timestamps; identity columns null', async () => {
      const before = Date.now();
      await ds.write('Thing', [{ id: 't5', name: 'auto' }]);
      const after = Date.now();
      const result = await ds.read('Thing', {});
      const row = result.rows.find((r) => r.id === 't5');
      expect(row?._metadata).toBeDefined();
      expect(row?._metadata?.createdAt).toBeTypeOf('string');
      expect(row?._metadata?.updatedAt).toBeTypeOf('string');
      const createdMs = Date.parse(row?._metadata?.createdAt ?? '');
      expect(createdMs).toBeGreaterThanOrEqual(before);
      expect(createdMs).toBeLessThanOrEqual(after);
      expect(row?._metadata?.createdBy).toBeNull();
      expect(row?._metadata?.updatedBy).toBeNull();
    });

    it('raw write with { identity, now } opts populates all four metadata fields from hint', async () => {
      const fixedNow = new Date('2026-04-27T12:00:00.000Z');
      const actor = { kind: 'agent' as const, id: 'k-test' };
      await ds.write('Thing', [{ id: 't-hint', name: 'hinted' }], {
        now: fixedNow,
        identity: actor
      });
      const result = await ds.read('Thing', {});
      const row = result.rows.find((r) => r.id === 't-hint');
      expect(row?._metadata).toEqual({
        createdAt: '2026-04-27T12:00:00.000Z',
        updatedAt: '2026-04-27T12:00:00.000Z',
        createdBy: actor,
        updatedBy: actor
      });
    });

    it('raw upsert with { now } over an existing row preserves createdAt; bumps updatedAt', async () => {
      const t0 = new Date('2026-04-27T10:00:00.000Z');
      const t1 = new Date('2026-04-27T11:00:00.000Z');
      const actor0 = { kind: 'agent' as const, id: 'creator' };
      const actor1 = { kind: 'agent' as const, id: 'updater' };

      await ds.write('Thing', [{ id: 'imm', name: 'v0' }], { now: t0, identity: actor0 });
      await ds.write('Thing', [{ id: 'imm', name: 'v1' }], { now: t1, identity: actor1 });

      const result = await ds.read('Thing', {});
      const row = result.rows.find((r) => r.id === 'imm');
      expect(row?.name).toBe('v1');
      expect(row?._metadata?.createdAt).toBe('2026-04-27T10:00:00.000Z');
      expect(row?._metadata?.updatedAt).toBe('2026-04-27T11:00:00.000Z');
      expect(row?._metadata?.createdBy).toEqual(actor0);
      expect(row?._metadata?.updatedBy).toEqual(actor1);
    });

    it('roundtrip — write then read returns equivalent _metadata', async () => {
      const meta = metadata('2026-04-25T01:00:00.000Z', { kind: 'user', id: 'u1' });
      await ds.write('Thing', [{ id: 't6', name: 'x', _metadata: meta }]);
      const result = await ds.read('Thing', {});
      const row = result.rows.find((r) => r.id === 't6');
      expect(row?._metadata).toEqual(meta);
    });

    it('body does not contain _metadata key after write+read', async () => {
      const meta = metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' });
      await ds.write('Thing', [{ id: 't7', name: 'y', _metadata: meta }]);
      // Read via raw SQL to inspect body directly
      const raw = await sql<{ body: Record<string, unknown> }[]>`
        SELECT body FROM rows WHERE id = 't7'
      `;
      expect(raw[0]?.body._metadata).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Filter classifier
  // ---------------------------------------------------------------------------
  describe('Filter classifier', () => {
    beforeEach(async () => {
      await ds.write('Thing', [
        {
          id: 't8',
          name: 'a',
          _metadata: metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' })
        },
        {
          id: 't9',
          name: 'b',
          _metadata: metadata('2026-04-25T01:00:00.000Z', { kind: 'agent', id: 'a2' })
        },
        {
          id: 't10',
          name: 'c',
          _metadata: metadata('2026-04-25T02:00:00.000Z', { kind: 'user', id: 'u1' })
        }
      ]);
    });

    it('where on createdAt routes to created_at column (gt range)', async () => {
      const result = await ds.read('Thing', {
        where: { createdAt: { gt: '2026-04-25T00:30:00.000Z' } }
      });
      expect(result.rows.map((r) => r.id).sort()).toEqual(['t10', 't9']);
    });

    it('where on createdByKind routes to created_by_kind column', async () => {
      const result = await ds.read('Thing', {
        where: { createdByKind: { eq: 'user' } }
      });
      expect(result.rows.map((r) => r.id)).toEqual(['t10']);
    });

    it('where on createdById routes to created_by_id column', async () => {
      const result = await ds.read('Thing', {
        where: { createdById: { eq: 'a2' } }
      });
      expect(result.rows.map((r) => r.id)).toEqual(['t9']);
    });

    it('where on updatedAt routes to updated_at column (between)', async () => {
      const result = await ds.read('Thing', {
        where: { updatedAt: { between: ['2026-04-25T00:30:00.000Z', '2026-04-25T01:30:00.000Z'] } }
      });
      expect(result.rows.map((r) => r.id)).toEqual(['t9']);
    });

    it('where on updatedByKind routes to updated_by_kind column', async () => {
      const result = await ds.read('Thing', {
        where: { updatedByKind: { eq: 'agent' } }
      });
      expect(result.rows.map((r) => r.id).sort()).toEqual(['t8', 't9']);
    });

    it('where on updatedById routes to updated_by_id column', async () => {
      const result = await ds.read('Thing', {
        where: { updatedById: { eq: 'u1' } }
      });
      expect(result.rows.map((r) => r.id)).toEqual(['t10']);
    });

    it('serves every author spelling once normalised onto the columns', async () => {
      const ids = async (where: Record<string, unknown>): Promise<string[]> => {
        const canonical = normaliseMetadataWhere(where, {}) as WhereClause;
        const result = await ds.read('Thing', { where: canonical });
        return result.rows.map((r) => String(r.id)).sort();
      };
      expect(await ids({ createdBy: { eq: 'a2' } })).toEqual(['t9']);
      expect(await ids({ createdBy: { eq: { kind: 'agent', id: 'a1' } } })).toEqual(['t8']);
      expect(await ids({ createdBy: { neq: { kind: 'agent', id: 'a1' } } })).toEqual(['t10', 't9']);
      expect(await ids({ createdBy: { in: ['u1', { kind: 'agent', id: 'a2' }] } })).toEqual([
        't10',
        't9'
      ]);
      expect(await ids({ createdBy: { nin: [{ kind: 'agent' }] } })).toEqual(['t10']);
      expect(await ids({ _metadata: { updatedBy: { kind: { eq: 'user' } } } })).toEqual(['t10']);
      expect(await ids({ 'createdBy.id': { startsWith: 'a' } })).toEqual(['t8', 't9']);
    });
  });
});
