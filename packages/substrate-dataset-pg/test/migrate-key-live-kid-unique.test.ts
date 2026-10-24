/**
 * The baseline's `substrate_key_live_kid_uniq` — one LIVE `_system/Key` per
 * principal.
 *
 * The property is two-sided, and a test that only asserted the REFUSAL would
 * pass for an index that forbade everything. `substrate-admin rotate` deliberately
 * leaves a rotation pair (one live, one revoked stamped `revokedAt`), and
 * re-registering over a revoked kid is deliberate too — so the permits matter
 * as much as the refusal.
 */

import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { partitionName, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = '_system';
const TYPE = 'Key';
// The index lives on the Key partition when rows is partitioned.
const INDEXED_TABLE =
  process.env.SUBSTRATE_STORAGE_LAYOUT === 'partitioned' ? partitionName(NS, TYPE) : 'rows';

describe.skipIf(!POSTGRES_URL)('unique LIVE kid per principal', () => {
  let sql: Sql;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`DROP TABLE IF EXISTS rows CASCADE`;
    await sql`DROP TABLE IF EXISTS migrations`;
    await runMigrations(sql);
  });

  afterEach(async () => {
    await sql?.end({ timeout: 5 });
  });

  const insert = async (id: string, body: Record<string, string>): Promise<void> => {
    await sql`INSERT INTO rows (id, namespace, type, body)
              VALUES (${id}, ${NS}, ${TYPE}, ${sql.json(body)})`;
  };

  it('REFUSES a second live row for the same kid — the race this exists to stop', async () => {
    await insert('11111111-1111-4111-8111-111111111111', { kid: 'dup@host' });
    await expect(
      insert('22222222-2222-4222-8222-222222222222', { kid: 'dup@host' })
    ).rejects.toThrow(/substrate_key_live_kid_uniq/);
  });

  it('PERMITS the rotation pair — one live, one revoked, same kid', async () => {
    await insert('33333333-3333-4333-8333-333333333333', { kid: 'rot@host' });
    await insert('44444444-4444-4444-8444-444444444444', {
      kid: 'rot@host',
      revokedAt: '2026-01-01T00:00:00Z'
    });
    const rows = await sql`SELECT id FROM rows WHERE body ->> 'kid' = 'rot@host'`;
    expect(rows).toHaveLength(2);
  });

  it('PERMITS many revoked rows for one kid — repeated rotation is not an error', async () => {
    for (let i = 0; i < 3; i++) {
      await insert(`5555555${i}-5555-4555-8555-555555555555`, {
        kid: 'many@host',
        revokedAt: `2026-0${i + 1}-01T00:00:00Z`
      });
    }
    const rows = await sql`SELECT id FROM rows WHERE body ->> 'kid' = 'many@host'`;
    expect(rows).toHaveLength(3);
  });

  it('scopes to _system/Key — an identical kid elsewhere is untouched', async () => {
    await insert('66666666-6666-4666-8666-666666666666', { kid: 'shared@host' });
    await sql`INSERT INTO rows (id, namespace, type, body)
              VALUES ('77777777-7777-4777-8777-777777777777', 'cortext', 'AgentIdentity',
                      ${sql.json({ kid: 'shared@host' })})`;
    const rows = await sql`SELECT id FROM rows WHERE body ->> 'kid' = 'shared@host'`;
    expect(rows).toHaveLength(2);
  });

  it('a soft-deleted live row does not block a replacement', async () => {
    await insert('88888888-8888-4888-8888-888888888888', { kid: 'del@host' });
    await sql`UPDATE rows SET deleted_at = now()
              WHERE id = '88888888-8888-4888-8888-888888888888'`;
    await insert('99999999-9999-4999-8999-999999999999', { kid: 'del@host' });
    const live = await sql`SELECT id FROM rows
                           WHERE body ->> 'kid' = 'del@host' AND deleted_at IS NULL`;
    expect(live).toHaveLength(1);
  });

  it('needs NO promoted column — the index is on the jsonb expression', async () => {
    // Pins the mechanism: `kid` stays in the jsonb body. Column promotion is
    // separately gated on cardinality, and Key does not qualify.
    const cols = await sql`SELECT column_name FROM information_schema.columns
                           WHERE table_schema = current_schema()
                             AND table_name = 'rows' AND column_name = 'kid'`;
    expect(cols).toHaveLength(0);

    const idx = await sql`SELECT indexdef FROM pg_indexes
                          WHERE schemaname = current_schema()
                            AND tablename = ${INDEXED_TABLE}
                            AND indexname = 'substrate_key_live_kid_uniq'`;
    expect(idx).toHaveLength(1);
    expect(String((idx[0] as { indexdef: string }).indexdef)).toContain("body ->> 'kid'");
  });
});
