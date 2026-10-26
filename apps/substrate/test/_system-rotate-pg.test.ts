/**
 * `substrate-admin rotate` against POSTGRES.
 *
 * The other rotate tests use a `MemoryDataset`, which has no unique index,
 * so migration 0023's `substrate_key_live_kid_uniq` cannot fail there.
 *
 * Pins that `rotate` can rotate a kid that is currently LIVE. A plain unique
 * index is enforced per statement rather than deferred to commit, so writing
 * the new row before revoking the old one would put two live rows on one
 * principal and fail the transaction.
 *
 * Pg-gated: skipped unless `POSTGRES_URL` is set.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/admin/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const KID = 'rotate-pg-fixture@TestHost';

describe.skipIf(!POSTGRES_URL)('substrate-admin rotate against pg', () => {
  let sql: Sql;
  let tmp: string;
  let out: Array<string>;
  let err: Array<string>;

  const env = (): Record<string, string> => ({ SUBSTRATE_DATABASE_URL: POSTGRES_URL as string });

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    // Applies 0023, which is the whole point — the index must be present or
    // this file asserts nothing the memory suite did not already cover.
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'substrate-rotate-pg-'));
    out = [];
    err = [];
    await sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE} AND body->>'kid' = ${KID}`;
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
    await sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE} AND body->>'kid' = ${KID}`;
  });

  /** Register KID for real, through the CLI, so the row is shaped as prod's. */
  async function registerLiveKid(): Promise<void> {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pub = join(tmp, 'fixture.pub');
    writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }) as string);
    const code = await main(
      [
        'register',
        KID,
        '--pubkey',
        pub,
        '--name',
        'rotate-pg fixture',
        '--ns',
        'cortext:read',
        '--direct'
      ],
      env(),
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(code).toBe(0);
    out = [];
    err = [];
  }

  async function liveRows(): Promise<Array<{ pk: string; name: string; ns: string }>> {
    const rows = await sql<Array<{ pk: string; name: string; ns: string }>>`
      SELECT body->>'publicKey' AS pk, body->>'name' AS name, body->>'namespaces' AS ns
        FROM rows
       WHERE namespace = ${SYSTEM_NAMESPACE}
         AND type = ${KEY_TYPE}
         AND deleted_at IS NULL
         AND body->>'kid' = ${KID}
         AND body->>'revokedAt' IS NULL`;
    return [...rows];
  }

  it('rotates a LIVE kid — the case migration 0023 made impossible', async () => {
    await registerLiveKid();
    const before = await liveRows();
    expect(before).toHaveLength(1);

    const code = await main(
      ['rotate', KID, '--out', join(tmp, 'new.key')],
      env(),
      (s) => out.push(s),
      (s) => err.push(s)
    );

    // Name the constraint explicitly, so a regression says WHICH invariant
    // broke rather than just "exit 1".
    expect(err.join('')).not.toContain('substrate_key_live_kid_uniq');
    expect(code).toBe(0);
  });

  it('leaves exactly ONE live row, carrying the new key and the old grant', async () => {
    await registerLiveKid();
    const [before] = await liveRows();

    await main(
      ['rotate', KID, '--out', join(tmp, 'new.key')],
      env(),
      (s) => out.push(s),
      (s) => err.push(s)
    );
    const after = await liveRows();

    // One live row is the invariant 0023 protects: two would be an auth
    // ambiguity, where WHICH key verifies depends on row ordering.
    expect(after).toHaveLength(1);
    // The principal keeps its authority — rotation replaces key material only.
    expect(after[0]?.name).toBe('rotate-pg fixture');
    expect(after[0]?.ns).toBe('cortext:read');
    // And the material actually changed, or "rotation" did nothing.
    expect(after[0]?.pk).not.toBe(before?.pk);
  });

  it('rotates the same principal twice', async () => {
    await registerLiveKid();
    for (const name of ['a.key', 'b.key']) {
      const code = await main(
        ['rotate', KID, '--out', join(tmp, name)],
        env(),
        (s) => out.push(s),
        (s) => err.push(s)
      );
      expect(err.join('')).toBe('');
      expect(code).toBe(0);
    }
    expect(await liveRows()).toHaveLength(1);
  });
});
