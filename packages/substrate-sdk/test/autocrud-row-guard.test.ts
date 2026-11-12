/**
 * autoCRUD writes honour row policies and never overwrite by id: a row the
 * caller cannot read cannot be updated or deleted, and create refuses a live id.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row } from '@mnmal-ai/substrate-policy';
import type { FieldDef, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { deleteResolver, installAutoCrud } from '../src/autocrud/index.js';

const FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  owner: { kind: 'scalar', type: 'string' },
  title: { kind: 'scalar', type: 'string' }
};

const OWNER_ONLY = row((ctx, r) => (r as { owner?: string }).owner === ctx.identity?.id);

async function setup() {
  const dataset = new MemoryDataset({ namespace: 'app' });
  await dataset.write('Note', [{ id: 'n1', owner: 'alice', title: 'secret' }]);
  const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-20T00:00:00Z') });
  const registry = new Registry();
  installAutoCrud(registry, 'Note', dataset, edges, {
    fields: FIELDS,
    policy: OWNER_ONLY,
    purgeable: true
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', dataset);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges
  });
  return { engine, dataset };
}

function as(id: string, caps: string[] = ['read', 'mutate']): RequestContext {
  return {
    identity: { kind: 'agent', id, agentKeyId: id, grants: { '*': caps } },
    namespace: 'app',
    operation: 'mutate',
    now: new Date('2026-04-20T00:00:00Z'),
    headers: {},
    meta: {}
  };
}

async function title(dataset: MemoryDataset): Promise<unknown> {
  return (await dataset.read('Note', { id: 'n1' })).rows[0]?.title;
}

describe('autoCRUD row guard', () => {
  it('does not update a row the caller cannot read', async () => {
    const { engine, dataset } = await setup();
    await engine.mutate({
      frame: {
        'app/updateNote': { params: { id: 'n1', title: 'bob was here' }, fields: { id: true } }
      },
      ctx: as('bob')
    });
    expect(await title(dataset)).toBe('secret');
  });

  it('does not delete a row the caller cannot read', async () => {
    const { engine, dataset } = await setup();
    await engine.mutate({
      frame: { 'app/deleteNote': { params: { id: 'n1' }, fields: { id: true, deleted: true } } },
      ctx: as('bob')
    });
    expect(await title(dataset)).toBe('secret');
  });

  it('reports a delete under a row policy as the delete result, not null', async () => {
    const owner = await setup();
    const mine = await owner.engine.mutate({
      frame: { 'app/deleteNote': { params: { id: 'n1' }, fields: { id: true, deleted: true } } },
      ctx: as('alice')
    });
    expect(mine.errors ?? []).toEqual([]);
    expect(mine.data['app/deleteNote']).toEqual({ id: 'n1', deleted: true });

    const other = await setup();
    const theirs = await other.engine.mutate({
      frame: { 'app/deleteNote': { params: { id: 'n1' }, fields: { id: true, deleted: true } } },
      ctx: as('bob')
    });
    expect(theirs.data['app/deleteNote']).toEqual({ id: 'n1', deleted: false });
  });

  it('does not purge a row the caller cannot read, and still lets the owner purge', async () => {
    const admin = ['read', 'mutate', 'admin'];
    const { engine, dataset } = await setup();
    const theirs = await engine.mutate({
      frame: { 'app/purgeNote': { params: { id: 'n1' }, fields: { id: true, purged: true } } },
      ctx: as('bob', admin)
    });
    expect(theirs.data['app/purgeNote']).toEqual({ id: 'n1', purged: false });
    expect(await title(dataset)).toBe('secret');

    const mine = await engine.mutate({
      frame: { 'app/purgeNote': { params: { id: 'n1' }, fields: { id: true, purged: true } } },
      ctx: as('alice', admin)
    });
    expect(mine.data['app/purgeNote']).toEqual({ id: 'n1', purged: true });
    expect(await title(dataset)).toBeUndefined();
  });

  it('deleteResolver with a policy leaves a row the caller cannot read', async () => {
    const { dataset } = await setup();
    const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-20T00:00:00Z') });
    const del = deleteResolver('Note', dataset, edges, { policy: OWNER_ONLY });
    expect(await del(as('bob'), { params: { id: 'n1' } })).toEqual({ id: 'n1', deleted: false });
    expect(await title(dataset)).toBe('secret');
    expect(await del(as('alice'), { params: { id: 'n1' } })).toEqual({ id: 'n1', deleted: true });
  });

  it('still lets the owner update', async () => {
    const { engine, dataset } = await setup();
    await engine.mutate({
      frame: { 'app/updateNote': { params: { id: 'n1', title: 'edited' }, fields: { id: true } } },
      ctx: as('alice')
    });
    expect(await title(dataset)).toBe('edited');
  });

  it('refuses create with the id of a live row', async () => {
    const { engine, dataset } = await setup();
    const res = await engine.mutate({
      frame: {
        'app/createNote': {
          params: { id: 'n1', owner: 'bob', title: 'mine now' },
          fields: { id: true }
        }
      },
      ctx: as('bob')
    });
    expect(res.errors?.[0]?.code).toBe('id_exists');
    expect(await title(dataset)).toBe('secret');
  });
});

describe('paging under a row policy', () => {
  it('seals the cursor and still reaches every visible row', async () => {
    const { engine, dataset } = await setup();
    await dataset.write('Note', [
      { id: 'n2', owner: 'bob', title: 'b1' },
      { id: 'n3', owner: 'alice', title: 'hidden' },
      { id: 'n4', owner: 'bob', title: 'b2' }
    ]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await engine.query({
        frame: {
          'app/Note': {
            params: { limit: 1, orderBy: [{ id: 'asc' }], ...(cursor ? { cursor } : {}) },
            fields: { id: true }
          }
        },
        ctx: { ...as('bob'), operation: 'query' }
      });
      if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
      for (const r of res.data['app/Note'] as { id: string }[]) seen.push(r.id);
      const pg = res._pagination?.['app/Note'];
      if (pg?.nextCursor !== undefined) expect(pg.nextCursor.startsWith('s1.')).toBe(true);
      if (!pg?.hasMore) break;
      cursor = pg.nextCursor;
    }
    expect(seen).toEqual(['n2', 'n4']);
  });

  it('refuses a sealed cursor that was tampered with', async () => {
    const { engine } = await setup();
    const res = await engine.query({
      frame: {
        'app/Note': {
          params: { cursor: 's1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
          fields: { id: true }
        }
      },
      ctx: { ...as('bob'), operation: 'query' }
    });
    expect(res.errors?.[0]?.code).toBe('invalid_cursor');
  });
});

describe('autoCRUD guards, edge cases', () => {
  it('refuses create with the id of a deleted row', async () => {
    const { engine, dataset } = await setup();
    await dataset.tombstone('Note', ['n1']);
    const res = await engine.mutate({
      frame: {
        'app/createNote': {
          params: { id: 'n1', owner: 'bob', title: 'revived' },
          fields: { id: true }
        }
      },
      ctx: as('bob')
    });
    expect(res.errors?.[0]?.code).toBe('id_exists');
  });

  it('refuses a raw cursor under a row policy', async () => {
    const { engine } = await setup();
    const raw = Buffer.from(JSON.stringify({ id: 'n1' })).toString('base64');
    const res = await engine.query({
      frame: { 'app/Note': { params: { cursor: raw }, fields: { id: true } } },
      ctx: { ...as('bob'), operation: 'query' }
    });
    expect(res.errors?.[0]?.code).toBe('invalid_cursor');
  });
});
