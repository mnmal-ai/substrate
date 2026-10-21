/**
 * Dropping a proposed namespace on pg archives its NamespaceProposal row in
 * the drop's own transaction: both commit together, or neither does. After a
 * drop the namespace leaves the engine and its name stays reserved.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { compose, SYSTEM_NAMESPACE, signHs256 } from '@mnmal-ai/substrate-compose';
import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { createNoopPubSub, createProposalsPlugin } from '@mnmal-ai/substrate-proposals';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const POSTGRES_URL = process.env.POSTGRES_URL;
const SECRET = 'drop-proposed-secret';
const NS = 'kdroppedns';
const CONTROL = '_system_proposals';

describe.skipIf(!POSTGRES_URL)('dropping a proposed namespace (pg)', () => {
  let sql: Sql;
  const stops: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterEach(async () => {
    while (stops.length > 0) await stops.pop()?.();
    await sql`DELETE FROM rows WHERE namespace IN (${NS}, ${CONTROL})`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function boot() {
    await sql`DELETE FROM rows WHERE namespace IN (${NS}, ${CONTROL})`;
    const edges = new PgEdgesStore({ sql });
    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset: new PgDataset({ namespace: 'default', sql, edgesStore: edges }),
      edges,
      // As the binary wires it: _system on the same pool, so one transaction spans the drop.
      datasets: {
        [SYSTEM_NAMESPACE]: new PgDataset({ namespace: SYSTEM_NAMESPACE, sql, edgesStore: edges })
      },
      coordinators: [createProposalsPlugin({ ownedNamespaces: [], pubsub: createNoopPubSub() })],
      auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' },
      streamTicketSecret: 'drop-proposed-ticket'
    });
    await server.start();
    stops.push(async () => {
      await composed.stop();
      await server.stop();
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256(
      {
        sub: 'op',
        exp: now + 120,
        capabilities: ['admin', 'read', 'mutate', 'substrate.propose'],
        ns: ['*']
      },
      SECRET,
      { kid: 'file' }
    );
    const post = (path: string, body: unknown) =>
      server.inject({
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: Buffer.from(JSON.stringify(body))
      });
    const propose = async (): Promise<string> => {
      const res = await post('/substrate/v1/mutate', {
        [`${CONTROL}/propose_namespace`]: {
          params: { ns: NS, proposedReason: 'drop test' },
          fields: { id: true }
        }
      });
      return String(res.body);
    };
    const drop = () => post('/substrate/v1/_system/drop-namespace', { namespace: NS, confirm: NS });
    const archivedFlags = async (): Promise<unknown[]> =>
      (
        await sql`SELECT body->>'archived' AS a FROM rows WHERE namespace = ${CONTROL} AND body->>'ns' = ${NS}`
      ).map((r) => r.a);
    return { engine: composed.engine, propose, drop, archivedFlags };
  }

  it('archives the proposal with the drop, takes the namespace off the engine, and reserves the name', async () => {
    const { engine, propose, drop, archivedFlags } = await boot();
    const proposed = await propose();
    expect(proposed, proposed).not.toMatch(/error/i);
    expect(engine.namespaceState(NS)).toBe('live');

    const res = await drop();
    expect(res.status, String(res.body)).toBe(200);

    expect(await archivedFlags()).toEqual(['true']);
    await vi.waitFor(() => expect(engine.namespaceState(NS)).toBe('absent'));
    const again = await propose();
    expect(again, again).toMatch(/namespace_retired/);
  });

  it('a participant that fails rolls back the drop and the archive together', async () => {
    const { engine, propose, drop, archivedFlags } = await boot();
    const proposed = await propose();
    expect(proposed, proposed).not.toMatch(/error/i);
    engine.addDropParticipant({
      namespaces: [CONTROL],
      onDrop: async () => {
        throw new Error('injected participant failure');
      }
    });

    const res = await drop();
    expect(res.status).toBeGreaterThanOrEqual(500);

    expect(await archivedFlags()).toEqual(['false']);
    expect(engine.namespaceState(NS)).toBe('live');
  });
});
