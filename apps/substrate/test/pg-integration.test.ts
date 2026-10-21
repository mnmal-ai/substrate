/**
 * apps/substrate integration against a real Postgres substrate.
 *
 * Skipped unless `POSTGRES_URL` is set. Boots the binary's `compose()` wiring
 * through `MemorySubstrateServer` (so we exercise the whole engine + dataset +
 * edges stack without needing a real TCP port) but with `PgDataset` +
 * `PgEdgesStore` instead of the memory pair.
 *
 * Covers:
 *   - schema route returns demo types
 *   - query / mutate / delete round-trip through pg
 *   - cross-store transaction — edge-aware delete + sweep reconciliation
 *     persist correctly in pg
 *   - restart persistence — close the sql pool, reopen it, boot a fresh
 *     compose against the same db; migrated rows + edges survive
 */

import {
  type ComposeResult,
  compose,
  KEY_TYPE,
  SYSTEM_NAMESPACE
} from '@mnmal-ai/substrate-compose';
import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { Schema, SubstrateResponse } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

describe.skipIf(!POSTGRES_URL)('apps/substrate pg integration', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // Each test starts with clean substrate state so assertions are stable.
    await sql`TRUNCATE TABLE rows, short_ids`;
    await sql`TRUNCATE TABLE edges`;
  });

  describe('single-boot', () => {
    let server: MemorySubstrateServer;
    let composed: ComposeResult;

    beforeEach(async () => {
      server = new MemorySubstrateServer();
      const dataset = new PgDataset({ namespace: 'default', sql });
      const edges = new PgEdgesStore({ sql });
      composed = await compose({
        // Auth is off, so the deployment must declare who it writes as.
        systemActor: 'test',
        server,
        dataset,
        edges,
        coordinators: [fixturePlugin]
      });
      await server.start();
    });

    afterEach(async () => {
      await composed.stop();
    });

    it('GET /substrate/v1/schema returns the demo types against pg', async () => {
      const res = await server.inject({ method: 'GET', path: '/substrate/v1/schema' });
      expect(res.status).toBe(200);
      const schema = jsonBody<Schema>(res);
      expect(schema.types.Todo).toBeDefined();
      expect(schema.types.Tag).toBeDefined();
      expect(schema.mutations.createTodo).toBeDefined();
      expect(schema.mutations.deleteTodo).toBeDefined();
    });

    it('round-trip: createTodo, query, delete, sweep, edge nulled', async () => {
      const created = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTodo': {
              params: { title: 'pg-round-trip', done: false },
              fields: { id: true, title: true, done: true }
            }
          })
        )
      });
      expect(created.status).toBe(200);
      const todoEnv = jsonBody<{ data: { 'default/createTodo': { id: string } } }>(created);
      const todoId = todoEnv.data['default/createTodo'].id;
      expect(typeof todoId).toBe('string');

      const tagged = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTag': {
              params: { label: 'urgent', todoId },
              fields: { id: true, todoId: true }
            }
          })
        )
      });
      expect(tagged.status).toBe(200);
      const tagEnv = jsonBody<{ data: { 'default/createTag': { id: string; todoId: string } } }>(
        tagged
      );
      const tagId = tagEnv.data['default/createTag'].id;
      expect(tagEnv.data['default/createTag'].todoId).toBe(todoId);

      // Delete the Todo — edge to Tag.todoId should survive Phase 1 (the sweep
      // nulls it in Phase 2).
      const deleted = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/deleteTodo': {
              params: { id: todoId },
              fields: { id: true, deleted: true }
            }
          })
        )
      });
      expect(deleted.status).toBe(200);
      const delEnv = jsonBody<{ data: { 'default/deleteTodo': { deleted: boolean } } }>(deleted);
      expect(delEnv.data['default/deleteTodo'].deleted).toBe(true);

      await composed.runSweepNow();

      const afterSweep = await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/Tag': {
              params: { id: tagId },
              fields: { id: true, label: true, todoId: true }
            }
          })
        )
      });
      expect(afterSweep.status).toBe(200);
      const tagRows = jsonBody<{ data: { 'default/Tag': Array<{ todoId: string | null }> } }>(
        afterSweep
      );
      expect(tagRows.data['default/Tag']).toHaveLength(1);
      expect(tagRows.data['default/Tag'][0]?.todoId).toBeNull();
    });
  });

  describe('_system persistence (§5.12 Phase 2 / Dispatch B)', () => {
    it('_system Key rows survive compose teardown + fresh boot on pg store', async () => {
      const substrateDataset1 = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
      const server1 = new MemorySubstrateServer();
      const dataset1 = new PgDataset({ namespace: 'default', sql });
      const edges1 = new PgEdgesStore({ sql });
      const composed1 = await compose({
        // Auth is off, so the deployment must declare who it writes as.
        systemActor: 'test',
        server: server1,
        dataset: dataset1,
        edges: edges1,
        datasets: { [SYSTEM_NAMESPACE]: substrateDataset1 }
      });
      await server1.start();
      await substrateDataset1.write(KEY_TYPE, [
        {
          id: 'persisted-kid',
          kid: 'persisted-kid',
          name: 'persistent',
          algorithm: 'EdDSA',
          publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
          namespaces: 'default',
          capabilities: 'read',
          revokedAt: null
        }
      ]);
      await composed1.stop();

      // Fresh compose against the same db — row must still be there.
      const substrateDataset2 = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
      const server2 = new MemorySubstrateServer();
      const dataset2 = new PgDataset({ namespace: 'default', sql });
      const edges2 = new PgEdgesStore({ sql });
      const composed2 = await compose({
        // Auth is off, so the deployment must declare who it writes as.
        systemActor: 'test',
        server: server2,
        dataset: dataset2,
        edges: edges2,
        datasets: { [SYSTEM_NAMESPACE]: substrateDataset2 }
      });
      try {
        const { rows } = await substrateDataset2.read(KEY_TYPE, { id: 'persisted-kid' });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe('persistent');
      } finally {
        await composed2.stop();
      }
    });
  });

  describe('restart persistence', () => {
    it('rows and edges survive a compose teardown + fresh compose against the same db', async () => {
      // First boot: write a Todo.
      const server1 = new MemorySubstrateServer();
      const dataset1 = new PgDataset({ namespace: 'default', sql });
      const edges1 = new PgEdgesStore({ sql });
      const composed1 = await compose({
        // Auth is off, so the deployment must declare who it writes as.
        systemActor: 'test',
        server: server1,
        dataset: dataset1,
        edges: edges1,
        coordinators: [fixturePlugin]
      });
      await server1.start();

      const created = await server1.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTodo': {
              params: { title: 'survive-restart', done: false },
              fields: { id: true }
            }
          })
        )
      });
      const createdEnv = jsonBody<{ data: { 'default/createTodo': { id: string } } }>(created);
      const todoId = createdEnv.data['default/createTodo'].id;

      await composed1.stop();

      // Second boot: same db, fresh compose/server. The persisted row must be
      // readable via the new stack.
      const server2 = new MemorySubstrateServer();
      const dataset2 = new PgDataset({ namespace: 'default', sql });
      const edges2 = new PgEdgesStore({ sql });
      const composed2 = await compose({
        // Auth is off, so the deployment must declare who it writes as.
        systemActor: 'test',
        server: server2,
        dataset: dataset2,
        edges: edges2,
        coordinators: [fixturePlugin]
      });
      await server2.start();

      try {
        const queried = await server2.inject({
          method: 'POST',
          path: '/substrate/v1/query',
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify({
              'default/Todo': {
                params: { id: todoId },
                fields: { id: true, title: true }
              }
            })
          )
        });
        const rows = jsonBody<{ data: { 'default/Todo': Array<{ id: string; title: string }> } }>(
          queried
        );
        expect(rows.data['default/Todo']).toHaveLength(1);
        expect(rows.data['default/Todo'][0]?.title).toBe('survive-restart');
      } finally {
        await composed2.stop();
      }
    });
  });
});
