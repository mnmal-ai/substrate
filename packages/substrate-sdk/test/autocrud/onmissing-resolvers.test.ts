import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  MissingReferentError,
  type RequestContext,
  type ResolverArgs
} from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createResolverWithEdges, updateResolver } from '../../src/autocrud/index.js';
import { field } from '../../src/field.js';

const fields = {
  id: field.string(),
  trace: field.crossRef('main', 'Trace', { onMissing: 'reject' })
};

const ctx = {
  now: new Date('2026-07-12T00:00:00Z'),
  // A write says who made it; these tests are about onMissing.
  identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } }
} as unknown as RequestContext;

describe('onMissing enforcement in autoCRUD resolvers', () => {
  let ds: MemoryDataset;
  let edges: MemoryEdgesStore;
  beforeEach(async () => {
    ds = new MemoryDataset({ namespace: 'main' });
    edges = new MemoryEdgesStore({ now: () => new Date('2026-07-12T00:00:00Z') });
    await ds.write('Trace', [{ id: 't1' }]);
  });

  it('create succeeds when the target exists', async () => {
    const create = createResolverWithEdges('Constituent', ds, edges, { fields });
    const args: ResolverArgs = { dataset: ds, edges, params: { id: 'c1', trace: 't1' } };
    const row = await create(ctx, args);
    expect(row?.id).toBe('c1');
  });

  it('create rejects (and writes no row) when the target is missing', async () => {
    const create = createResolverWithEdges('Constituent', ds, edges, { fields });
    const args: ResolverArgs = { dataset: ds, edges, params: { id: 'c2', trace: 'nope' } };
    await expect(create(ctx, args)).rejects.toBeInstanceOf(MissingReferentError);
    const { rows } = await ds.read('Constituent', { id: 'c2', includeDeleted: true });
    expect(rows).toHaveLength(0);
  });

  it('update rejects when repointing to a missing target', async () => {
    // seed a valid Constituent first
    const create = createResolverWithEdges('Constituent', ds, edges, { fields });
    await create(ctx, { dataset: ds, edges, params: { id: 'c3', trace: 't1' } });

    const update = updateResolver('Constituent', ds, edges, { fields });
    const args: ResolverArgs = { dataset: ds, edges, params: { id: 'c3', trace: 'gone' } };
    await expect(update(ctx, args)).rejects.toBeInstanceOf(MissingReferentError);

    // The rejected update must write nothing — confirm the row still carries
    // its original, valid crossRef value rather than the rejected repoint.
    const { rows } = await ds.read('Constituent', { id: 'c3' });
    expect(rows[0]?.trace).toBe('t1');
  });

  it('update on a non-existent row reports not_found BEFORE checking the crossRef', async () => {
    // The row-existence check runs first, so a caller who mistyped the row id
    // is told about the row id — not handed a MissingReferentError about `trace`.
    const update = updateResolver('Constituent', ds, edges, { fields });
    const args: ResolverArgs = { dataset: ds, edges, params: { id: 'missing-row', trace: 'gone' } };
    await expect(update(ctx, args)).rejects.toMatchObject({ code: 'not_found' });
  });
});
