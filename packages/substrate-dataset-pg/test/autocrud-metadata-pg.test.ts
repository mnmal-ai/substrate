/**
 * PG autoCRUD `_metadata` round-trip.
 *
 * Regression: `updateField('_metadata', ...)` must write the metadata columns,
 * not body. The read mapper rebuilds `_metadata` from columns, so a body write
 * returns stale create-time metadata.
 *
 * Requires POSTGRES_URL; skipped when absent.
 */

import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { createResolver, updateResolver } from '@mnmal-ai/substrate-sdk';
import type {
  ActorIdentity,
  FieldDef,
  Identity,
  RequestContext,
  RowMetadata
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

const THING_FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  name: { kind: 'scalar', type: 'string' }
};

/**
 * THING_FIELDS declares no crossRef field, so `updateResolver` never
 * dereferences this store; it only satisfies the required `EdgesStore` param.
 */
function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-25T00:00:00Z') });
}

function agentIdentity(agentKeyId: string): Identity {
  // Full local authority so the gate never decides these attribution tests.
  return { id: agentKeyId, agentKeyId, grants: { '*': ['read', 'mutate'] } };
}

function ctxAt(at: string, identity: RequestContext['identity'] = null): RequestContext {
  return {
    identity,
    namespace: 'test',
    operation: 'mutate',
    now: new Date(at),
    headers: {},
    meta: {}
  };
}

function metadata(at: string, by: ActorIdentity): RowMetadata {
  return { createdAt: at, updatedAt: at, createdBy: by, updatedBy: by };
}

describe.skipIf(!POSTGRES_URL)('PG dataset autocrud update round-trip (regression)', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`DROP TABLE IF EXISTS rows CASCADE`;
    // `force: true` drops the migration-tracking table so the framework
    // re-applies every migration on this call, recreating rows.
    await runMigrations(sql, { force: true });
    ds = new PgDataset({ namespace: 'test', sql });
  });

  afterEach(async () => {
    await sql.end();
  });

  // -------------------------------------------------------------------------
  // Direct updateField test
  // -------------------------------------------------------------------------
  it('updateField(_metadata) routes to columns, not body', async () => {
    // 1. Insert row with _metadata via ds.write()
    await ds.write('Thing', [
      {
        id: 'r1',
        name: 'original',
        _metadata: metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' })
      }
    ]);

    // 2. Call ds.updateField with new _metadata
    const newMeta: RowMetadata = {
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T01:00:00.000Z',
      createdBy: { kind: 'agent', id: 'a1' },
      updatedBy: { kind: 'agent', id: 'a2' }
    };
    await ds.updateField({ ns: 'test', type: 'Thing', id: 'r1' }, '_metadata', newMeta);

    // 3. Direct SQL probe: verify columns hold the new values
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
        SELECT created_at, updated_at, created_by_kind, created_by_id,
               updated_by_kind, updated_by_id, body
        FROM rows
        WHERE namespace = 'test' AND type = 'Thing' AND id = 'r1'
      `;

    expect(cols[0]?.created_at?.toISOString()).toBe('2026-04-25T00:00:00.000Z');
    expect(cols[0]?.updated_at?.toISOString()).toBe('2026-04-25T01:00:00.000Z');
    expect(cols[0]?.created_by_kind).toBe('agent');
    expect(cols[0]?.created_by_id).toBe('a1');
    expect(cols[0]?.updated_by_kind).toBe('agent');
    expect(cols[0]?.updated_by_id).toBe('a2');

    // 4. Body must NOT contain _metadata (single source of truth)
    expect(cols[0]?.body._metadata).toBeUndefined();

    // 5. Read back via ds.read(): verify _metadata equals new values
    const result = await ds.read('Thing', { id: 'r1' });
    const row = result.rows[0];
    expect(row?._metadata).toEqual(newMeta);
  });

  // -------------------------------------------------------------------------
  // autoCRUD round-trip
  // -------------------------------------------------------------------------
  it('autocrud update through PG bumps updatedAt + updatedBy via columns', async () => {
    const create = createResolver('Thing', ds, { fields: THING_FIELDS });
    const update = updateResolver('Thing', ds, makeEdges(), { fields: THING_FIELDS });

    // Create with a1 at T0
    await create(ctxAt('2026-04-25T00:00:00.000Z', agentIdentity('a1')), {
      params: { id: 'r2', name: 'original' }
    });

    // Update with a2 at T1
    const updated = await update(ctxAt('2026-04-25T01:00:00.000Z', agentIdentity('a2')), {
      params: { id: 'r2', name: 'patched' }
    });

    // updatedAt + updatedBy must reflect the update
    expect(updated?._metadata?.updatedAt).toBe('2026-04-25T01:00:00.000Z');
    expect(updated?._metadata?.updatedBy).toEqual({ kind: 'agent', id: 'a2' });

    // createdAt + createdBy must be preserved (immutable)
    expect(updated?._metadata?.createdAt).toBe('2026-04-25T00:00:00.000Z');
    expect(updated?._metadata?.createdBy).toEqual({ kind: 'agent', id: 'a1' });
  });

  it('autocrud update: columns hold correct values (direct SQL probe)', async () => {
    const create = createResolver('Thing', ds, { fields: THING_FIELDS });
    const update = updateResolver('Thing', ds, makeEdges(), { fields: THING_FIELDS });

    await create(ctxAt('2026-04-25T00:00:00.000Z', agentIdentity('a1')), {
      params: { id: 'r3', name: 'original' }
    });
    await update(ctxAt('2026-04-25T01:00:00.000Z', agentIdentity('a2')), {
      params: { id: 'r3', name: 'patched' }
    });

    const cols = await sql<
      {
        created_at: Date | null;
        updated_at: Date | null;
        created_by_id: string | null;
        updated_by_id: string | null;
        body: Record<string, unknown>;
      }[]
    >`
        SELECT created_at, updated_at, created_by_id, updated_by_id, body
        FROM rows
        WHERE namespace = 'test' AND type = 'Thing' AND id = 'r3'
      `;

    expect(cols[0]?.created_at?.toISOString()).toBe('2026-04-25T00:00:00.000Z');
    expect(cols[0]?.updated_at?.toISOString()).toBe('2026-04-25T01:00:00.000Z');
    expect(cols[0]?.created_by_id).toBe('a1');
    expect(cols[0]?.updated_by_id).toBe('a2');
    // Body must never carry _metadata
    expect(cols[0]?.body._metadata).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // COALESCE check — upsert preserves created_* when re-writing without
  // explicit _metadata. The second raw write auto-fills updatedAt from
  // wall-clock but supplies null identity; COALESCE(null, existing) preserves
  // the prior updatedBy — matching memory-dataset's `??` semantic.
  // -------------------------------------------------------------------------
  it('upsert preserves createdAt/createdBy on raw re-write; bumps updatedAt; preserves updatedBy via null-fallback (COALESCE)', async () => {
    // 1. Insert row with explicit _metadata.
    const meta = metadata('2026-04-25T00:00:00.000Z', { kind: 'agent', id: 'a1' });
    await ds.write('Thing', [{ id: 'r4', name: 'first', _metadata: meta }]);

    const before = Date.now();
    // 2. Re-write same id WITHOUT _metadata + WITHOUT identity hint
    //    (simulates raw-write bypass path with no provenance info).
    await ds.write('Thing', [{ id: 'r4', name: 'second' }]);
    const after = Date.now();

    // 3. Read back: created_* preserved (existing-wins COALESCE post-flip);
    //    updatedAt bumped to wall-clock (auto-fill + EXCLUDED-wins COALESCE);
    //    updatedBy preserved (auto-fill provides null, COALESCE falls back to
    //    existing — matches memory-dataset's mergeRowMetadata `??` semantic).
    const result = await ds.read('Thing', { id: 'r4' });
    const row = result.rows[0];
    expect(row?._metadata?.createdAt).toBe('2026-04-25T00:00:00.000Z');
    expect(row?._metadata?.createdBy).toEqual({ kind: 'agent', id: 'a1' });
    const updatedMs = Date.parse(row?._metadata?.updatedAt ?? '');
    expect(updatedMs).toBeGreaterThanOrEqual(before);
    expect(updatedMs).toBeLessThanOrEqual(after);
    // Preserved (not cleared) because COALESCE(null, existing) falls back to existing.
    expect(row?._metadata?.updatedBy).toEqual({ kind: 'agent', id: 'a1' });
  });
});
