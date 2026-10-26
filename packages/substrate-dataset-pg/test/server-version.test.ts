/**
 * The store refuses a PostgreSQL server older than 18 before migrating.
 * The refusal is checked through the pure helper, since the test server is 18+.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertServerVersion,
  checkServerVersionNum,
  UnsupportedServerVersionError
} from '../src/server-version.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('assertServerVersion', () => {
  let sql: Sql;

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    await sql.end();
  });

  it('accepts the connected server (18+)', async () => {
    await expect(assertServerVersion(sql)).resolves.toBeUndefined();
  });
});

describe('checkServerVersionNum', () => {
  it('refuses a server below 18 with the found version', () => {
    let caught: unknown;
    try {
      checkServerVersionNum(170009);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedServerVersionError);
    expect((caught as UnsupportedServerVersionError).found).toBe(170009);
    expect((caught as Error).message).toContain('PostgreSQL 18');
  });

  it('accepts 18.0', () => {
    expect(() => checkServerVersionNum(180000)).not.toThrow();
  });
});
