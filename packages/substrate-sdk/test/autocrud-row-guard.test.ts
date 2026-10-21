/**
 * autoCRUD writes honour row policies and never overwrite by id: a row the
 * caller cannot read cannot be updated or deleted, and create refuses a live id.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row } from '@mnmal-ai/substrate-policy';
import type { FieldDef, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installAutoCrud } from '../src/autocrud/index.js';

const FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  owner: { kind: 'scalar', type: 'string' },
  title: { kind: 'scalar', type: 'string' }
};

async function setup() {
  const dataset = new MemoryDataset({ namespace: 'app' });
  await dataset.write('Note', [{ id: 'n1', owner: 'alice', title: 'secret' }]);
  const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-20T00:00:00Z') });
  const registry = new Registry();
  installAutoCrud(registry, 'Note', dataset, edges, {
    fields: FIELDS,
    policy: row((ctx, r) => (r as { owner?: string }).owner === ctx.identity?.id)
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

function as(id: string): RequestContext {
  return {
    identity: { kind: 'agent', id, agentKeyId: id, grants: { '*': ['read', 'mutate'] } },
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
