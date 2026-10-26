/**
 * Storage layout: fresh databases are partitioned (or legacy on request),
 * existing ones keep the layout they have, and `partitionName` stays within
 * pg's identifier limit. Each pg test runs in a throwaway schema of its own.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectLayout,
  partitionName,
  runMigrations,
  StorageLayoutMismatchError
} from '../src/index.js';
import { hashedName } from '../src/layout.js';
import {
  CONCURRENT_STATEMENTS,
  SYSTEM_KEY_PARTITION,
  SYSTEM_PARTITION
} from '../src/migrations/0001p_partitioned_baseline.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe('partitionName', () => {
  it('names namespace and type partitions readably when the names are already clean', () => {
    expect(partitionName('_system')).toBe('rows___system');
    expect(partitionName('cortext', 'todo')).toBe('rows__cortext__todo');
  });

  it('stays within 63 bytes for a 60-char namespace and a 60-char type, and is stable', () => {
    const ns = 'n'.repeat(60);
    const type = 't'.repeat(60);
    const name = partitionName(ns, type);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(partitionName(ns, type)).toBe(name);
    expect(partitionName(ns, 'u'.repeat(60))).not.toBe(name);
  });

  it('names the baseline _system partitions with partitionName', () => {
    expect(SYSTEM_PARTITION).toBe(partitionName('_system'));
    expect(SYSTEM_KEY_PARTITION).toBe(partitionName('_system', 'Key'));
  });

  it('carries every 0001 concurrent index except those on rows', () => {
    expect(CONCURRENT_STATEMENTS).toHaveLength(7);
    expect(CONCURRENT_STATEMENTS.join('\n')).not.toMatch(/ON rows\b/);
  });

  it('appends a hash when sanitising changed a name', () => {
    expect(partitionName('A-b', 'T')).toMatch(/^rows__a_b__t_[0-9a-f]{8}$/);
    expect(partitionName('a-b')).not.toBe(partitionName('a_b'));
  });

  it('cuts a hashed name to the length it is given, room for a suffix', () => {
    const long = 'x'.repeat(80);
    expect(hashedName(long, long)).toHaveLength(63);
    expect(`${hashedName(long, long, 57)}__swap`).toHaveLength(63);
  });
});

describe.skipIf(!POSTGRES_URL)('storage layout', () => {
  let sql: Sql;
  let schema: string;

  beforeEach(async () => {
    schema = `substrate_layout_${randomBytes(4).toString('hex')}`;
    // One connection, so the SET below reaches every query, the migration runner's included.
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
  });

  afterEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  const keyPartition = partitionName('_system', 'Key');

  it('reports absent before any migration', async () => {
    expect(await detectLayout(sql)).toBe('absent');
  });

  it('builds a fresh database partitioned, with the _system/Key partition and its kid index', async () => {
    await runMigrations(sql, { layout: 'partitioned' });
    expect(await detectLayout(sql)).toBe('partitioned');

    const parted = await sql`
      SELECT 1 FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid
      WHERE c.relname = 'rows' AND c.relnamespace = current_schema()::regnamespace`;
    expect(parted).toHaveLength(1);

    const idx = await sql<Array<{ table: string }>>`
      SELECT tablename AS table FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'substrate_key_live_kid_uniq'`;
    expect(idx.map((r) => r.table)).toEqual([keyPartition]);

    const versions = await sql<
      Array<{ version: string }>
    >`SELECT version FROM migrations ORDER BY version`;
    expect(versions.map((r) => r.version)).toEqual([
      '0001p_partitioned_baseline',
      '0003_safe_casts',
      '0004_visible_seq'
    ]);
  });

  it('builds a fresh database legacy on request, as a plain table', async () => {
    await runMigrations(sql, { layout: 'legacy' });
    expect(await detectLayout(sql)).toBe('legacy');
    const [row] = await sql<Array<{ relkind: string }>>`
      SELECT relkind::text FROM pg_class
      WHERE relname = 'rows' AND relnamespace = current_schema()::regnamespace`;
    expect(row?.relkind).toBe('r');
    const idx = await sql`
      SELECT 1 FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'rows' AND indexname = 'substrate_key_live_kid_uniq'`;
    expect(idx).toHaveLength(1);
  });

  it('never converts an existing legacy database', async () => {
    await runMigrations(sql, { layout: 'legacy' });
    await runMigrations(sql, { layout: 'partitioned' });
    expect(await detectLayout(sql)).toBe('legacy');
  });

  it('refuses a ledger whose baseline does not match the layout of rows', async () => {
    await runMigrations(sql, { layout: 'partitioned' });
    await sql`INSERT INTO migrations (version, checksum) VALUES ('0001_baseline', 'x')`;
    await expect(runMigrations(sql)).rejects.toBeInstanceOf(StorageLayoutMismatchError);
  });

  it('refuses two live _system/Key rows for one kid on the partitioned layout', async () => {
    await runMigrations(sql, { layout: 'partitioned' });
    const insert = (id: string) =>
      sql`INSERT INTO rows (namespace, type, id, body)
          VALUES ('_system', 'Key', ${id}, ${sql.json({ kid: 'dup@host' })})`;
    await insert('k1');
    await expect(insert('k2')).rejects.toThrow(/substrate_key_live_kid_uniq/);
  });

  it('cascades a short_ids row when its row is deleted through a partition', async () => {
    await runMigrations(sql, { layout: 'partitioned' });
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('_system', 'Key', 'k1', '{}')`;
    await sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('_system', 'Key', 1, 'k1')`;
    await sql.unsafe(`DELETE FROM ${keyPartition} WHERE id = 'k1'`);
    expect(await sql`SELECT 1 FROM short_ids`).toHaveLength(0);
  });
});
