import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NamespaceMismatch, PgDataset, ReservedField, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PgDataset', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // Truncate sidecar too — without this, shortId allocations accumulate
    // across runs on a long-lived local DB and fail strict toEqual assertions.
    await sql`TRUNCATE TABLE rows, short_ids`;
    ds = new PgDataset({ namespace: 'test_ns', sql });
  });

  describe('namespace + capabilities', () => {
    it('readonly namespace matches constructor arg', () => {
      expect(ds.namespace).toBe('test_ns');
    });

    it('exposes full §5.2 operator capability set', () => {
      expect(ds.capabilities.orderBy).toBe(true);
      expect(ds.capabilities.cursor).toBe(true);
      expect(ds.capabilities.operators['scalar.number']).toContain('between');
      expect(ds.capabilities.operators['scalar.string']).toContain('contains');
      expect(ds.capabilities.operators['scalar.boolean']).toEqual(['eq']);
    });
  });

  describe('write', () => {
    it('insertOnly skips an existing row, live or tombstoned, and omits it', async () => {
      await ds.write('Todo', [
        { id: 'live', title: 'orig' },
        { id: 'dead', title: 'orig' }
      ]);
      await ds.tombstone('Todo', ['dead']);
      const res = await ds.write(
        'Todo',
        [
          { id: 'live', title: 'over' },
          { id: 'dead', title: 'over' },
          { id: 'new', title: 'fresh' }
        ],
        { insertOnly: true }
      );
      expect(res.ids).toEqual(['new']);
      expect(res.rows.map((r) => r.title)).toEqual(['fresh']);
      const { rows } = await ds.read('Todo', { includeDeleted: true, orderBy: [{ id: 'asc' }] });
      expect(rows.map((r) => [r.id, r.title])).toEqual([
        ['dead', 'orig'],
        ['live', 'orig'],
        ['new', 'fresh']
      ]);
    });

    it('upserts rows and returns ids', async () => {
      const res = await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      expect(res.written).toBe(2);
      expect(res.ids).toEqual([1, 2]);

      const { rows } = await ds.read('Todo', {});
      expect(rows).toHaveLength(2);
    });

    it('returns merged rows in WriteResult.rows', async () => {
      const first = await ds.write('Todo', [
        { id: 1, title: 'a', tag: 'x' },
        { id: 2, title: 'b' }
      ]);
      // Sorted by input order — substrate must preserve the input row order.
      expect(first.rows.map((r) => r.id)).toEqual([1, 2]);
      expect(first.rows[0]?.title).toBe('a');
      expect(first.rows[0]?.tag).toBe('x');

      // Second write merges body keys per pg's `body || EXCLUDED.body` and
      // preserves _metadata via COALESCE. WriteResult.rows reflects the
      // post-merge state so autoCRUD update can skip its post-read.
      const second = await ds.write('Todo', [{ id: 1, title: 'updated' }]);
      expect(second.rows[0]?.title).toBe('updated');
      expect(second.rows[0]?.tag).toBe('x');
    });

    it('merges on second write with same id', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a', tag: 'x' }]);
      await ds.write('Todo', [{ id: 1, title: 'updated' }]);

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]).toMatchObject({ id: 1, title: 'updated', tag: 'x' });
    });

    it('a write carrying the existing _metadata leaves it unchanged (no updatedAt bump)', async () => {
      // The contract vocabulary normalisation relies on: rewriting a value is
      // not an edit, so the row's history must not move.
      const past = new Date('2026-01-01T00:00:00Z');
      await ds.write('Todo', [{ id: 'm1', status: 'accepted' }], {
        identity: { kind: 'agent', id: 'seed' },
        now: past
      });
      const before = (await ds.read('Todo', { id: 'm1' })).rows[0]?._metadata;
      await ds.write('Todo', [{ id: 'm1', status: 'active', _metadata: before } as never]);
      const after = (await ds.read('Todo', { id: 'm1' })).rows[0];
      expect(after?.status).toBe('active');
      expect(after?._metadata).toEqual(before);
    });

    it('ignores caller-supplied _deletedAt (stored live)', async () => {
      await ds.write('Todo', [
        // biome-ignore lint/suspicious/noExplicitAny: test cast for reserved field
        { id: 1, title: 'a', _deletedAt: new Date() } as any
      ]);

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]).toBeDefined();
      expect(rows[0]?._deletedAt).toBeUndefined();
    });

    it('ignores caller-supplied _deletedAt: null (stored live)', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a', _deletedAt: null }]);

      const { rows } = await ds.read('Todo', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?._deletedAt).toBeUndefined();
    });

    it('write cannot revive a tombstone via _deletedAt: null', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.tombstone('Todo', [1]);

      await ds.write('Todo', [{ id: 1, title: 'revived', _deletedAt: null }]);

      const { rows: live } = await ds.read('Todo', {});
      expect(live).toHaveLength(0);
      const { rows: all } = await ds.read('Todo', { includeDeleted: true });
      expect(all).toHaveLength(1);
      expect(all[0]?._deletedAt).toBeInstanceOf(Date);
    });

    it('rejects missing id', async () => {
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: intentionally-missing id
        ds.write('Todo', [{ title: 'a' } as any])
      ).rejects.toThrow(/row.id is required/);
    });

    it('preserves numeric id round-trip', async () => {
      await ds.write('Todo', [{ id: 42, title: 'n' }]);
      const { rows } = await ds.read('Todo', { id: 42 });
      expect(rows[0]?.id).toBe(42);
      expect(typeof rows[0]?.id).toBe('number');
    });

    it('preserves string id round-trip', async () => {
      await ds.write('Todo', [{ id: 'abc', title: 's' }]);
      const { rows } = await ds.read('Todo', { id: 'abc' });
      expect(rows[0]?.id).toBe('abc');
      expect(typeof rows[0]?.id).toBe('string');
    });
  });

  describe('read', () => {
    it('empty store returns []', async () => {
      const { rows } = await ds.read('Todo', {});
      expect(rows).toEqual([]);
    });

    it('filters tombstoned rows by default', async () => {
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      await ds.tombstone('Todo', [1]);

      const { rows } = await ds.read('Todo', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    });

    it('includeDeleted: true returns tombstoned rows with _deletedAt Date', async () => {
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      await ds.tombstone('Todo', [1]);

      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(2);
      const tombstoned = rows.find((r) => r.id === 1);
      expect(tombstoned?._deletedAt).toBeInstanceOf(Date);
    });

    it('returns empty array for unknown type', async () => {
      const { rows } = await ds.read('Unknown', {});
      expect(rows).toEqual([]);
    });

    it('filters by id', async () => {
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      const { rows } = await ds.read('Todo', { id: 2 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    });

    it('filters by ids', async () => {
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
        { id: 3, title: 'c' }
      ]);
      const { rows } = await ds.read('Todo', { ids: [1, 3] });
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([1, 3]);
    });

    it('honours limit — caller receives at most n live rows', async () => {
      await ds.write(
        'Todo',
        Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: `t${i + 1}` }))
      );

      const { rows: capped } = await ds.read('Todo', { limit: 10 });
      expect(capped).toHaveLength(10);

      const { rows: zero } = await ds.read('Todo', { limit: 0 });
      expect(zero).toHaveLength(0);

      const { rows: unbounded } = await ds.read('Todo', {});
      expect(unbounded).toHaveLength(25);
    });

    it('limit is applied after _deletedAt filter', async () => {
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
        { id: 3, title: 'c' },
        { id: 4, title: 'd' }
      ]);
      await ds.tombstone('Todo', [1, 2]);

      const { rows } = await ds.read('Todo', { limit: 10 });
      expect(rows.map((r) => r.id).sort()).toEqual([3, 4]);
    });
  });

  describe('tombstone', () => {
    it('stamps _deletedAt', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      const res = await ds.tombstone('Todo', [1]);

      expect(res.deleted).toBe(1);
      expect(res.ids).toEqual([1]);

      const { rows } = await ds.read('Todo', { id: 1, includeDeleted: true });
      expect(rows[0]?._deletedAt).toBeInstanceOf(Date);
    });

    it('terminal — second tombstone returns 0 and preserves original timestamp', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.tombstone('Todo', [1]);

      const { rows: firstRows } = await ds.read('Todo', { id: 1, includeDeleted: true });
      const originalStamp = firstRows[0]?._deletedAt as Date;

      await new Promise((r) => setTimeout(r, 10));

      const res = await ds.tombstone('Todo', [1]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);

      const { rows: secondRows } = await ds.read('Todo', { id: 1, includeDeleted: true });
      expect((secondRows[0]!._deletedAt as Date).getTime()).toBe(originalStamp.getTime());
    });

    it('silent no-op for nonexistent id', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      const res = await ds.tombstone('Todo', [999]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });

    it('returns 0 for unknown type', async () => {
      const res = await ds.tombstone('Unknown', [1, 2]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });

    it('mixed batch: counts only newly-stamped ids', async () => {
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
        { id: 3, title: 'c' }
      ]);
      await ds.tombstone('Todo', [1]);

      const res = await ds.tombstone('Todo', [1, 2, 999]);
      expect(res.deleted).toBe(1);
      expect(res.ids).toEqual([2]);
    });
  });

  describe('purge', () => {
    it('removes live rows entirely', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      const res = await ds.purge('Todo', [1]);
      expect(res.deleted).toBe(1);
      expect(res.ids).toEqual([1]);

      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(0);
    });

    it('removes tombstoned rows entirely', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.tombstone('Todo', [1]);
      const res = await ds.purge('Todo', [1]);
      expect(res.deleted).toBe(1);

      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(0);
    });

    it('returns 0 on nonexistent id', async () => {
      const res = await ds.purge('Todo', [999]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });

    it('returns 0 on unknown type', async () => {
      const res = await ds.purge('Unknown', [1]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });
  });

  describe('updateField', () => {
    it('sets a field', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.updateField({ type: 'Todo', id: 1 }, 'status', 'done');

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]?.status).toBe('done');
    });

    it('persists null as JSONB null (key present with null value)', async () => {
      // Regression: `set_null` policy in the sweep path calls updateField with
      // value === null. Expectation: the key exists on the row and reads back
      // as `null`, NOT absent. Memory impl is the reference; pg must match.
      await ds.write('Todo', [{ id: 1, title: 'a', crossRefId: 'x' }]);
      await ds.updateField({ type: 'Todo', id: 1 }, 'crossRefId', null);

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]).toBeDefined();
      expect('crossRefId' in (rows[0] as object)).toBe(true);
      expect(rows[0]?.crossRefId).toBeNull();
    });

    it('creates the key as JSONB null when the field is absent', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.updateField({ type: 'Todo', id: 1 }, 'crossRefId', null);

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]).toBeDefined();
      expect('crossRefId' in (rows[0] as object)).toBe(true);
      expect(rows[0]?.crossRefId).toBeNull();
    });

    it('throws ReservedField when updating _deletedAt', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await expect(
        ds.updateField({ type: 'Todo', id: 1 }, '_deletedAt', new Date())
      ).rejects.toBeInstanceOf(ReservedField);
    });

    it('throws NamespaceMismatch for mismatched ref.ns', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await expect(
        ds.updateField({ ns: 'other_ns', type: 'Todo', id: 1 }, 'status', 'done')
      ).rejects.toBeInstanceOf(NamespaceMismatch);
    });

    it('succeeds with matching ref.ns', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.updateField({ ns: 'test_ns', type: 'Todo', id: 1 }, 'status', 'done');

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]?.status).toBe('done');
    });

    it('silent no-op on nonexistent row', async () => {
      await expect(
        ds.updateField({ type: 'Todo', id: 999 }, 'status', 'done')
      ).resolves.toBeUndefined();
    });

    it('silent no-op on nonexistent type', async () => {
      await expect(
        ds.updateField({ type: 'Unknown', id: 1 }, 'status', 'done')
      ).resolves.toBeUndefined();
    });

    it('validation order: namespace mismatch fires BEFORE reserved-field check', async () => {
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await expect(
        ds.updateField({ ns: 'other_ns', type: 'Todo', id: 1 }, '_deletedAt', new Date())
      ).rejects.toBeInstanceOf(NamespaceMismatch);
    });

    it('validation order: reserved-field check fires BEFORE missing-row check', async () => {
      await expect(
        ds.updateField({ type: 'Todo', id: 999 }, '_deletedAt', new Date())
      ).rejects.toBeInstanceOf(ReservedField);
    });
  });

  // ----------------------------------------------------------------------
  // conditionalUpdate (§5.12)
  // ----------------------------------------------------------------------

  describe('conditionalUpdate', () => {
    it('returns matched:true + merged row when every match clause holds', async () => {
      await ds.write('Invite', [{ id: 'inv-1', consumedAt: null, capacity: 5 }]);
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-1',
        { consumedAt: null },
        { consumedAt: new Date('2026-04-19T00:00:00Z'), consumedBy: 'kid-abc' }
      );
      expect(res.matched).toBe(true);
      expect(res.row?.consumedBy).toBe('kid-abc');
      expect(res.row?.capacity).toBe(5);
    });

    it('returns matched:false when the match predicate fails (no write lands)', async () => {
      const alreadyConsumed = new Date('2026-04-18T00:00:00Z');
      await ds.write('Invite', [{ id: 'inv-2', consumedAt: alreadyConsumed, consumedBy: 'kid-x' }]);
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-2',
        { consumedAt: null },
        { consumedBy: 'kid-y' }
      );
      expect(res.matched).toBe(false);
      expect(res.row).toBeNull();
      const { rows } = await ds.read('Invite', { id: 'inv-2' });
      expect(rows[0]?.consumedBy).toBe('kid-x');
    });

    it('returns matched:false when the row does not exist', async () => {
      const res = await ds.conditionalUpdate('Invite', 'missing', {}, { foo: 'bar' });
      expect(res).toEqual({ matched: false, row: null });
    });

    it('concurrent callers serialise — exactly one matches on a single-consume row', async () => {
      await ds.write('Invite', [{ id: 'race', consumedAt: null }]);
      const fire = (): Promise<{ matched: boolean }> =>
        ds.conditionalUpdate(
          'Invite',
          'race',
          { consumedAt: null },
          { consumedAt: new Date(), consumedBy: 'winner' }
        );
      const results = await Promise.all([fire(), fire(), fire(), fire()]);
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(1);
    });

    it('Date equality works against stored ISO-string Dates', async () => {
      const at = new Date('2026-01-01T00:00:00Z');
      await ds.write('Token', [{ id: 't1', rotatedAt: at }]);
      const ok = await ds.conditionalUpdate(
        'Token',
        't1',
        { rotatedAt: new Date(at.getTime()) },
        { rotatedAt: new Date('2026-06-01T00:00:00Z') }
      );
      expect(ok.matched).toBe(true);
      const fail = await ds.conditionalUpdate(
        'Token',
        't1',
        { rotatedAt: new Date('2025-01-01T00:00:00Z') },
        { rotatedAt: new Date() }
      );
      expect(fail.matched).toBe(false);
    });

    it('silently strips _deletedAt and id from the updates map', async () => {
      await ds.write('Todo', [{ id: 'r1', title: 'original' }]);
      const res = await ds.conditionalUpdate(
        'Todo',
        'r1',
        {},
        { id: 'r2', _deletedAt: new Date(), title: 'updated' }
      );
      expect(res.matched).toBe(true);
      expect(res.row?.id).toBe('r1');
      expect(res.row?._deletedAt).toBeUndefined();
      expect(res.row?.title).toBe('updated');
    });

    it('skips tombstoned rows (treated as absent)', async () => {
      await ds.write('Invite', [{ id: 'tomb', consumedAt: null }]);
      await ds.tombstone('Invite', ['tomb']);
      const res = await ds.conditionalUpdate(
        'Invite',
        'tomb',
        { consumedAt: null },
        { consumedBy: 'x' }
      );
      expect(res.matched).toBe(false);
    });

    // ─── Metadata bump ──────────────────────────────────────────────────
    it('bumps updated_at + updated_by columns on a successful match', async () => {
      await ds.write('Invite', [
        {
          id: 'meta-1',
          consumedAt: null,
          _metadata: {
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            createdBy: { kind: 'agent', id: 'a-original' },
            updatedBy: { kind: 'agent', id: 'a-original' }
          }
        }
      ]);

      const beforeMs = Date.now();
      const actor = { kind: 'agent' as const, id: 'kid-abc' };
      const res = await ds.conditionalUpdate(
        'Invite',
        'meta-1',
        { consumedAt: null },
        { consumedAt: new Date('2026-04-19T00:00:00Z'), consumedBy: 'kid-abc' },
        actor
      );
      const afterMs = Date.now();

      expect(res.matched).toBe(true);
      const meta = res.row?._metadata;
      expect(meta).toBeDefined();
      const updatedMs = Date.parse(meta?.updatedAt ?? '');
      // updated_at is server-set via now() — should land between the wall-clock
      // bookends, with a small skew tolerance for clock drift on the pg side.
      expect(updatedMs).toBeGreaterThanOrEqual(beforeMs - 1000);
      expect(updatedMs).toBeLessThanOrEqual(afterMs + 1000);
      expect(meta?.updatedBy).toEqual(actor);
      expect(meta?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(meta?.createdBy).toEqual({ kind: 'agent', id: 'a-original' });

      // Direct column probe — the columns themselves must hold the new values.
      const cols = await sql<
        { updated_by_kind: string; updated_by_id: string; created_by_id: string }[]
      >`
        SELECT updated_by_kind, updated_by_id, created_by_id
        FROM rows
        WHERE namespace = 'test_ns' AND type = 'Invite' AND id = 'meta-1'
      `;
      expect(cols[0]?.updated_by_kind).toBe('agent');
      expect(cols[0]?.updated_by_id).toBe('kid-abc');
      expect(cols[0]?.created_by_id).toBe('a-original');
    });

    it('falls back to system/anonymous when actor is omitted', async () => {
      await ds.write('Invite', [{ id: 'meta-noActor', consumedAt: null }]);
      const res = await ds.conditionalUpdate(
        'Invite',
        'meta-noActor',
        { consumedAt: null },
        { consumedBy: 'someone' }
      );
      expect(res.matched).toBe(true);
      expect(res.row?._metadata?.updatedBy).toEqual({ kind: 'system', id: 'anonymous' });
    });

    it('failed match does not touch metadata columns', async () => {
      const original = '2026-01-01T00:00:00.000Z';
      await ds.write('Invite', [
        {
          id: 'meta-fail',
          consumedAt: new Date('2026-02-01T00:00:00Z'),
          _metadata: {
            createdAt: original,
            updatedAt: original,
            createdBy: { kind: 'agent', id: 'a1' },
            updatedBy: { kind: 'agent', id: 'a1' }
          }
        }
      ]);
      const res = await ds.conditionalUpdate(
        'Invite',
        'meta-fail',
        { consumedAt: null },
        { consumedBy: 'attempted' }
      );
      expect(res.matched).toBe(false);
      const cols = await sql<{ updated_at: Date; updated_by_id: string }[]>`
        SELECT updated_at, updated_by_id FROM rows
        WHERE namespace = 'test_ns' AND type = 'Invite' AND id = 'meta-fail'
      `;
      expect(cols[0]?.updated_at?.toISOString()).toBe(original);
      expect(cols[0]?.updated_by_id).toBe('a1');
    });
  });

  describe('short-id methods', () => {
    const TEST_SHORT_ID_NS = 'test_pg_dataset_shortid';

    /**
     * Seed a placeholder rows row so a subsequent bindShortId can
     * satisfy the composite FK installed by migration 0010. Body is empty
     * jsonb — these unit tests only exercise the short-id path.
     */
    async function seedRow(type: string, id: string): Promise<void> {
      await sql`
        INSERT INTO rows (namespace, type, id, body)
        VALUES (${TEST_SHORT_ID_NS}, ${type}, ${id}, '{}'::jsonb)
        ON CONFLICT (namespace, type, id) DO NOTHING
      `;
    }

    beforeEach(async () => {
      // Clean up rows + short-id rows + sequences for this test namespace.
      // Deleting rows cascades to short_ids via the FK from
      // migration 0010; both are deleted for explicitness.
      await sql`
        DELETE FROM rows
        WHERE namespace = ${TEST_SHORT_ID_NS}
      `;
      await sql`
        DELETE FROM short_ids
        WHERE namespace = ${TEST_SHORT_ID_NS}
      `;
      const seqs = await sql<Array<{ sequencename: string }>>`
        SELECT sequencename FROM pg_sequences
        WHERE sequencename LIKE 'test_pg_dataset_shortid__%'
      `;
      for (const { sequencename } of seqs) {
        await sql.unsafe(`DROP SEQUENCE IF EXISTS "${sequencename}"`);
      }
    });

    it('allocateShortId advances per type', async () => {
      const shortDs = new PgDataset({ namespace: TEST_SHORT_ID_NS, sql });
      expect(await shortDs.allocateShortId('Todo')).toBe(1);
      expect(await shortDs.allocateShortId('Todo')).toBe(2);
      expect(await shortDs.allocateShortId('Decision')).toBe(1);
    });

    it('bindShortId + resolveShortId round-trip', async () => {
      const shortDs = new PgDataset({ namespace: TEST_SHORT_ID_NS, sql });
      await seedRow('Item', 'row-uuid-1');
      const sid = await shortDs.allocateShortId('Item');
      await shortDs.bindShortId('Item', sid, 'row-uuid-1');
      expect(await shortDs.resolveShortId('Item', sid)).toBe('row-uuid-1');
    });

    it('getShortIdForRow returns the bound shortId', async () => {
      const shortDs = new PgDataset({ namespace: TEST_SHORT_ID_NS, sql });
      await seedRow('Item', 'row-uuid-2');
      const sid = await shortDs.allocateShortId('Item');
      await shortDs.bindShortId('Item', sid, 'row-uuid-2');
      expect(await shortDs.getShortIdForRow('Item', 'row-uuid-2')).toBe(sid);
    });

    it('resolveShortId returns null for unknown shortId', async () => {
      const shortDs = new PgDataset({ namespace: TEST_SHORT_ID_NS, sql });
      expect(await shortDs.resolveShortId('Item', 99999)).toBeNull();
    });

    it('getShortIdForRow returns null for unknown rowId', async () => {
      const shortDs = new PgDataset({ namespace: TEST_SHORT_ID_NS, sql });
      expect(await shortDs.getShortIdForRow('Item', 'no-such-row')).toBeNull();
    });

    it('tx-scoped bindShortId rolls back with the transaction', async () => {
      const shortDs = new PgDataset({ namespace: TEST_SHORT_ID_NS, sql });
      await seedRow('Widget', 'row-tx-rollback');
      // Allocate outside the tx (sequence advance always persists).
      const sid = await shortDs.allocateShortId('Widget');

      // Bind inside a tx that throws — sidecar row should not persist.
      await expect(
        shortDs.withTransaction(async (tx) => {
          await tx.bindShortId('Widget', sid, 'row-tx-rollback');
          throw new Error('intentional rollback');
        })
      ).rejects.toThrow('intentional rollback');

      // The binding should not exist after rollback.
      expect(await shortDs.resolveShortId('Widget', sid)).toBeNull();
    });

    describe('read — where.shortId filters via sidecar join', () => {
      const READ_SHORT_ID_NS = 'test_pg_dataset_read_shortid';

      beforeEach(async () => {
        await sql`DELETE FROM rows WHERE namespace = ${READ_SHORT_ID_NS}`;
        await sql`DELETE FROM short_ids WHERE namespace = ${READ_SHORT_ID_NS}`;
        const seqs = await sql<Array<{ sequencename: string }>>`
          SELECT sequencename FROM pg_sequences
          WHERE sequencename LIKE 'test_pg_dataset_read_shortid__%'
        `;
        for (const { sequencename } of seqs) {
          await sql.unsafe(`DROP SEQUENCE IF EXISTS "${sequencename}"`);
        }
      });

      it('returns shortId in read results via LEFT JOIN', async () => {
        const ds = new PgDataset({ namespace: READ_SHORT_ID_NS, sql });
        await ds.write('Item', [{ id: 'r1', name: 'first' }]);
        const sid = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid, 'r1');

        const { rows } = await ds.read('Item', {});
        expect(rows.length).toBe(1);
        expect((rows[0] as Record<string, unknown>).shortId).toBe(sid);
      });

      it('returns null shortId for rows without a sidecar binding', async () => {
        const ds = new PgDataset({ namespace: READ_SHORT_ID_NS, sql });
        await ds.write('Item', [{ id: 'unbound', name: 'no-shortid' }]);

        const { rows } = await ds.read('Item', {});
        expect(rows.length).toBe(1);
        expect((rows[0] as Record<string, unknown>).shortId).toBeUndefined();
      });

      it('filters by where.shortId.eq via sidecar join', async () => {
        const ds = new PgDataset({ namespace: READ_SHORT_ID_NS, sql });
        await ds.write('Item', [
          { id: 'r1', name: 'first' },
          { id: 'r2', name: 'second' },
          { id: 'r3', name: 'third' }
        ]);
        const sid1 = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid1, 'r1');
        const sid2 = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid2, 'r2');
        const sid3 = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid3, 'r3');

        const { rows } = await ds.read('Item', { where: { shortId: { eq: sid2 } } });
        expect(rows.length).toBe(1);
        expect((rows[0] as Record<string, unknown>).id).toBe('r2');
        expect((rows[0] as Record<string, unknown>).shortId).toBe(sid2);
      });

      it('filters by where.shortId.in via sidecar join', async () => {
        const ds = new PgDataset({ namespace: READ_SHORT_ID_NS, sql });
        await ds.write('Item', [
          { id: 'r1', name: 'first' },
          { id: 'r2', name: 'second' },
          { id: 'r3', name: 'third' }
        ]);
        const sid1 = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid1, 'r1');
        const sid2 = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid2, 'r2');
        const sid3 = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid3, 'r3');

        const { rows } = await ds.read('Item', { where: { shortId: { in: [sid1, sid3] } } });
        const ids = rows.map((r) => (r as Record<string, unknown>).id).sort();
        expect(ids).toEqual(['r1', 'r3']);
      });

      it('filters by where.shortId range (gte + lt)', async () => {
        const ds = new PgDataset({ namespace: READ_SHORT_ID_NS, sql });
        for (let i = 1; i <= 5; i++) {
          await ds.write('Item', [{ id: `r${i}`, name: `item${i}` }]);
          const sid = await ds.allocateShortId('Item');
          await ds.bindShortId('Item', sid, `r${i}`);
        }

        const { rows } = await ds.read('Item', { where: { shortId: { gte: 2, lt: 5 } } });
        const shortIds = rows
          .map((r) => (r as Record<string, unknown>).shortId as number)
          .sort((a, b) => a - b);
        expect(shortIds).toEqual([2, 3, 4]);
      });

      it('returns empty when no rows match where.shortId.eq', async () => {
        const ds = new PgDataset({ namespace: READ_SHORT_ID_NS, sql });
        await ds.write('Item', [{ id: 'r1', name: 'first' }]);
        const sid = await ds.allocateShortId('Item');
        await ds.bindShortId('Item', sid, 'r1');

        const { rows } = await ds.read('Item', { where: { shortId: { eq: 99999 } } });
        expect(rows.length).toBe(0);
      });
    });
  });
});
