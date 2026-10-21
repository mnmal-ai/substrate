/**
 * autoCRUD row-metadata population.
 *
 * Verifies that:
 *   - create: attaches full RowMetadata (createdAt=updatedAt=ctx.now,
 *     createdBy=updatedBy=resolveIdentity(ctx))
 *   - update: bumps updatedAt + updatedBy; preserves createdAt + createdBy
 *   - legacy rows (no prior _metadata) get auto-filled createdAt on write
 */

import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, Identity, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { createResolver, updateResolver } from '../src/autocrud/index.js';

const THING_FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  name: { kind: 'scalar', type: 'string' }
};

/**
 * THING_FIELDS declares no crossRef field, so `updateResolver` never
 * dereferences this store — it just needs a valid `EdgesStore` to satisfy the
 * constructor param shared with `createResolverWithEdges`.
 */
function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-25T00:00:00Z') });
}

/** Agent identity — uses Identity's [k: string]: unknown index signature. */
function agentIdentity(agentKeyId: string): Identity {
  // Test actor: full local authority so the gate never decides these
  // attribution-focused tests.
  return { id: agentKeyId, agentKeyId, grants: { '*': ['read', 'mutate'] } };
}

function ctxAt(at: string, identity: RequestContext['identity'] = null): RequestContext {
  return {
    identity,
    namespace: 'default',
    operation: 'mutate',
    now: new Date(at),
    headers: {},
    meta: {}
  };
}

describe('autoCRUD row-metadata population', () => {
  it('create populates createdAt + updatedAt + createdBy + updatedBy from ctx.now + resolveIdentity(ctx)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const create = createResolver('Thing', dataset, { fields: THING_FIELDS });
    const ctx = ctxAt('2026-04-25T00:00:00.000Z', agentIdentity('a1'));
    const row = await create(ctx, { params: { id: 't1', name: 'x' } });
    expect(row._metadata).toEqual({
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:00:00.000Z',
      createdBy: { kind: 'agent', id: 'a1' },
      updatedBy: { kind: 'agent', id: 'a1' }
    });
  });

  it('update bumps updatedAt + updatedBy from current ctx.now + resolveIdentity(ctx)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const create = createResolver('Thing', dataset, { fields: THING_FIELDS });
    const update = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    await create(ctxAt('2026-04-25T00:00:00.000Z', agentIdentity('a1')), {
      params: { id: 't2', name: 'original' }
    });
    const updatedRow = await update(ctxAt('2026-04-25T01:00:00.000Z', agentIdentity('a2')), {
      params: { id: 't2', name: 'patched' }
    });
    expect(updatedRow?._metadata?.updatedAt).toBe('2026-04-25T01:00:00.000Z');
    expect(updatedRow?._metadata?.updatedBy).toEqual({ kind: 'agent', id: 'a2' });
  });

  it('update preserves createdAt + createdBy (immutable)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const create = createResolver('Thing', dataset, { fields: THING_FIELDS });
    const update = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    await create(ctxAt('2026-04-25T00:00:00.000Z', agentIdentity('a1')), {
      params: { id: 't3', name: 'original' }
    });
    const updatedRow = await update(ctxAt('2026-04-25T01:00:00.000Z', agentIdentity('a2')), {
      params: { id: 't3', name: 'patched' }
    });
    expect(updatedRow?._metadata?.createdAt).toBe('2026-04-25T00:00:00.000Z');
    expect(updatedRow?._metadata?.createdBy).toEqual({ kind: 'agent', id: 'a1' });
  });

  // An unattributed write is refused rather than attributed to a name that
  // identifies nobody.
  it('create with null identity is REFUSED, not attributed to anonymous', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const create = createResolver('Thing', dataset, { fields: THING_FIELDS });
    const ctx = ctxAt('2026-04-25T00:00:00.000Z', null);
    await expect(create(ctx, { params: { id: 't4', name: 'anon' } })).rejects.toThrow(
      /unattributed write/i
    );
    // And nothing landed — a refused write must not half-apply.
    const { rows } = await dataset.read('Thing', { where: { id: { eq: 't4' } } });
    expect(rows).toHaveLength(0);
  });

  it('update on legacy row (no prior _metadata) auto-fills createdAt/createdBy on write', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    // Bypass createResolver — write directly via dataset to simulate a row
    // that predates this feature (no _metadata in storage).
    const before = Date.now();
    await dataset.write('Thing', [{ id: 't5', name: 'legacy' }]);
    const after = Date.now();
    const update = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    const updated = await update(ctxAt('2026-04-25T01:00:00.000Z', agentIdentity('a1')), {
      params: { id: 't5', name: 'patched' }
    });
    // Raw writes auto-fill _metadata when absent. The initial
    // write gets wall-clock auto-filled createdAt; the update bumps updatedAt
    // while preserving createdAt via per-field COALESCE.
    const createdMs = Date.parse(updated?._metadata?.createdAt ?? '');
    expect(createdMs).toBeGreaterThanOrEqual(before);
    expect(createdMs).toBeLessThanOrEqual(after);
    expect(updated?._metadata?.createdBy).toBeNull();
    expect(updated?._metadata?.updatedAt).toBe('2026-04-25T01:00:00.000Z');
    expect(updated?._metadata?.updatedBy).toEqual({ kind: 'agent', id: 'a1' });
  });
});
