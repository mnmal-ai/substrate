/**
 * `enumCheckStatements` generates pg CHECK constraints from the same vocab
 * constant `field.enum` uses. Pinned for shape, naming, value escaping and
 * refusal of degenerate inputs, plus a pg-gated proof that the emitted DDL
 * actually constrains.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumCheckStatements } from '../src/enum-check.js';
import { runMigrations } from '../src/migrate.js';

const squash = (sql: string): string =>
  sql
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ',')
    .trim();

describe('enumCheckStatements', () => {
  it('drops then adds a NOT VALID check scoped to its (namespace, type)', () => {
    const { constraintName, statements } = enumCheckStatements({
      namespace: 'app',
      type: 'Task',
      field: 'status',
      vocab: ['open', 'done']
    });
    expect(statements).toEqual([
      `ALTER TABLE rows DROP CONSTRAINT IF EXISTS ${constraintName}`,
      expect.any(String)
    ]);
    expect(squash(statements[1] as string)).toBe(
      squash(`ALTER TABLE rows ADD CONSTRAINT ${constraintName} CHECK (
        NOT (namespace = 'app' AND type = 'Task')
        OR body->>'status' IS NULL
        OR body->>'status' IN ('open','done')
      ) NOT VALID`)
    );
  });

  it('derives the constraint name from (ns, type, field), sanitized to an identifier', () => {
    const { constraintName } = enumCheckStatements({
      namespace: 'app',
      type: 'Note',
      field: 'category',
      vocab: ['git']
    });
    expect(constraintName).toMatch(/^rows_app_note_category_[0-9a-f]{8}_check$/);
  });

  it('gives fields that sanitise or truncate alike distinct names, within 63 bytes', () => {
    const name = (type: string, field: string): string =>
      enumCheckStatements({ namespace: 'app', type, field, vocab: ['a'] }).constraintName;
    expect(name('Note', 'my-tags')).not.toBe(name('Note', 'my_tags'));
    const long = 'T'.repeat(70);
    const a = name(long, 'first');
    const b = name(long, 'second');
    expect(a).not.toBe(b);
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(63);
    expect(Buffer.byteLength(b)).toBeLessThanOrEqual(63);
  });

  it('escapes single quotes in literals rather than emitting broken SQL', () => {
    const { statements } = enumCheckStatements({
      namespace: 'labs',
      type: 'Trace',
      field: 'mode',
      vocab: ["it's", 'plain']
    });
    expect(statements[1]).toContain(`IN ('it''s','plain')`);
  });

  it('refuses an empty vocabulary — IN () is a syntax error, and an enum with no values checks nothing', () => {
    expect(() =>
      enumCheckStatements({ namespace: 'labs', type: 'Trace', field: 'mode', vocab: [] })
    ).toThrow(/empty vocabulary/);
  });

  it('refuses empty namespace/type/field — a guard that cannot name its subject guards nothing', () => {
    expect(() =>
      enumCheckStatements({ namespace: '', type: 'Trace', field: 'mode', vocab: ['a'] })
    ).toThrow(/non-empty/);
  });

  it('grandfathers existing rows (NOT VALID) while letting NULL bypass', () => {
    const { statements } = enumCheckStatements({
      namespace: 'labs',
      type: 'Trace',
      field: 'mode',
      vocab: ['a']
    });
    expect(statements[1]).toContain('NOT VALID');
    expect(statements[1]).toContain(`body->>'mode' IS NULL`);
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('enumCheckStatements — live DDL proof', () => {
  let sql: Sql;
  const NS = 'coverage-probe';
  const TYPE = 'Probe';
  const FIELD = 'mode';
  const NAME = enumCheckStatements({
    namespace: NS,
    type: TYPE,
    field: FIELD,
    vocab: ['a']
  }).constraintName;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    // A fresh database has no `rows` table until something migrates it.
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.unsafe(`ALTER TABLE rows DROP CONSTRAINT IF EXISTS ${NAME}`);
    await sql.end();
  });

  it('rejects out-of-vocab writes, accepts in-vocab + NULL + other types', async () => {
    const { statements } = enumCheckStatements({
      namespace: NS,
      type: TYPE,
      field: FIELD,
      vocab: ['a', 'b']
    });
    for (const stmt of statements) await sql.unsafe(stmt);
    const id = `probe-${Date.now()}`;

    // In-vocab passes.
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES (${NS}, ${TYPE}, ${id}, ${sql.json({ mode: 'a' })})`;
    // NULL bypasses (absence is not a vocabulary concern).
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES (${NS}, ${TYPE}, ${`${id}-null`}, ${sql.json({})})`;
    // Other types bypass via the NOT leg.
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('other', ${TYPE}, ${`${id}-other`}, ${sql.json({ mode: 'zzz' })})`;
    // Out-of-vocab on the guarded field is refused.
    await expect(
      sql`INSERT INTO rows (namespace, type, id, body) VALUES (${NS}, ${TYPE}, ${`${id}-bad`}, ${sql.json({ mode: 'zzz' })})`
    ).rejects.toThrow(/new row for relation "rows[a-z0-9_]*" violates check constraint/);

    await sql`DELETE FROM rows WHERE namespace = ${NS} AND type = ${TYPE}`;
    await sql`DELETE FROM rows WHERE namespace = 'other' AND type = ${TYPE}`;
    await sql.unsafe(`ALTER TABLE rows DROP CONSTRAINT IF EXISTS ${NAME}`);
  });
});
