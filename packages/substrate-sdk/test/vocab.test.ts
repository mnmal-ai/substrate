/**
 * Governed vocabulary: an enum plus an alias table. Synonyms are
 * normalised to the canonical value on write and in filters; unknown values
 * are rejected with the vocabulary and aliases, unless the field is not strict.
 */

import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { createResolver, listResolver, updateResolver } from '../src/autocrud/index.js';
import { assertVocabImplications } from '../src/autocrud/internal.js';
import { field } from '../src/field.js';

const ctx = (): RequestContext => ({
  identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
  namespace: 'default',
  operation: 'mutate',
  now: new Date('2026-10-03T00:00:00Z'),
  headers: {},
  meta: {}
});
const edges = () => new MemoryEdgesStore({ now: () => new Date('2026-10-03T00:00:00Z') });

const status = field.vocab(['open', 'active', 'superseded'], {
  aliases: { accepted: 'active', adopted: 'active', decided: 'active' }
});
const FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  name: { kind: 'scalar', type: 'string' },
  status
};

async function seeded() {
  const ds = new MemoryDataset({ namespace: 'default' });
  const create = createResolver('Decision', ds, { fields: FIELDS });
  await create(ctx(), { params: { id: 'd1', name: 'a', status: 'active' } });
  await create(ctx(), { params: { id: 'd2', name: 'b', status: 'open' } });
  await create(ctx(), { params: { id: 'd3', name: 'c', status: 'superseded' } });
  return ds;
}

describe('field.vocab', () => {
  it('is a string enum carrying its alias table', () => {
    expect(status).toEqual({
      kind: 'scalar',
      type: 'string',
      indexed: true,
      enum: ['open', 'active', 'superseded'],
      aliases: { accepted: 'active', adopted: 'active', decided: 'active' }
    });
  });

  it('refuses an alias that points outside the vocabulary', () => {
    expect(() => field.vocab(['open'], { aliases: { done: 'closed' } })).toThrow(/closed/);
  });

  it('refuses an alias that shadows a canonical value', () => {
    expect(() => field.vocab(['open', 'closed'], { aliases: { open: 'closed' } })).toThrow(/open/);
  });

  it('refuses a default outside the vocabulary', () => {
    expect(() => field.vocab(['open'], { default: 'nope' })).toThrow(/nope/);
  });
});

describe('writes', () => {
  it('stores the canonical value when an alias is written, on create and update', async () => {
    const ds = new MemoryDataset({ namespace: 'default' });
    const row = await createResolver('Decision', ds, { fields: FIELDS })(ctx(), {
      params: { id: 'x', name: 'n', status: 'accepted' }
    });
    expect(row.status).toBe('active');
    const updated = await updateResolver('Decision', ds, edges(), { fields: FIELDS })(ctx(), {
      params: { id: 'x', status: 'superseded' }
    });
    expect(updated?.status).toBe('superseded');
    const again = await updateResolver('Decision', ds, edges(), { fields: FIELDS })(ctx(), {
      params: { id: 'x', status: 'Decided' }
    });
    expect(again?.status).toBe('active');
  });

  it('normalises the case of a canonical value', async () => {
    const ds = new MemoryDataset({ namespace: 'default' });
    const row = await createResolver('Decision', ds, { fields: FIELDS })(ctx(), {
      params: { name: 'n', status: 'ACTIVE' }
    });
    expect(row.status).toBe('active');
  });

  it('rejects an unknown value, naming the vocabulary and its aliases', async () => {
    const ds = new MemoryDataset({ namespace: 'default' });
    await expect(
      createResolver('Decision', ds, { fields: FIELDS })(ctx(), {
        params: { name: 'n', status: 'maybe' }
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'invalid_enum_value',
        details: {
          field: 'status',
          value: 'maybe',
          allowed: ['open', 'active', 'superseded'],
          aliases: { accepted: 'active', adopted: 'active', decided: 'active' }
        }
      })
    );
  });

  it('admits an unknown value on a non-strict vocabulary, still normalising aliases', async () => {
    const loose: Record<string, FieldDef> = {
      name: { kind: 'scalar', type: 'string' },
      status: field.vocab(['active'], { aliases: { accepted: 'active' }, strict: false })
    };
    const ds = new MemoryDataset({ namespace: 'default' });
    const create = createResolver('Decision', ds, { fields: loose });
    expect((await create(ctx(), { params: { name: 'n', status: 'experimental' } })).status).toBe(
      'experimental'
    );
    expect((await create(ctx(), { params: { name: 'n', status: 'accepted' } })).status).toBe(
      'active'
    );
  });
});

describe('filters', () => {
  const ids = async (where: unknown) => {
    const ds = await seeded();
    const res = await listResolver('Decision', ds, { fields: FIELDS })(ctx(), {
      params: { where }
    });
    return res.rows.map((r) => r.id).sort();
  };

  it('normalises an alias in eq, neq, in and nin', async () => {
    expect(await ids({ status: { eq: 'accepted' } })).toEqual(['d1']);
    expect(await ids({ status: { neq: 'accepted' } })).toEqual(['d2', 'd3']);
    expect(await ids({ status: { in: ['accepted', 'open'] } })).toEqual(['d1', 'd2']);
    expect(await ids({ status: { nin: ['Adopted'] } })).toEqual(['d2', 'd3']);
  });

  it('normalises inside AND / OR / NOT', async () => {
    expect(
      await ids({ OR: [{ status: { eq: 'decided' } }, { status: { eq: 'superseded' } }] })
    ).toEqual(['d1', 'd3']);
    expect(await ids({ AND: [{ status: { eq: 'accepted' } }, { name: { eq: 'a' } }] })).toEqual([
      'd1'
    ]);
    expect(await ids({ NOT: { status: { eq: 'accepted' } } })).toEqual(['d2', 'd3']);
  });

  it('leaves a field without aliases, and a list resolver without fields, untouched', async () => {
    expect(await ids({ name: { eq: 'b' } })).toEqual(['d2']);
    const ds = await seeded();
    const res = await listResolver('Decision', ds)(ctx(), {
      params: { where: { status: { eq: 'accepted' } } }
    });
    expect(res.rows).toEqual([]);
  });
});

describe('alias implications', () => {
  const TODO: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    title: { kind: 'scalar', type: 'string' },
    status: field.vocab(['open', 'closed'], {
      aliases: { done: 'closed', cancelled: 'closed' },
      implies: { done: { resolution: 'completed' }, cancelled: { resolution: 'wont_do' } }
    }),
    resolution: field.vocab(['completed', 'wont_do'], {
      nullable: true,
      aliases: { shipped: 'completed' }
    })
  };
  const create = (ds: MemoryDataset) => createResolver('Todo', ds, { fields: TODO });

  it('fills the implied sibling when an alias is written', async () => {
    const row = await create(new MemoryDataset({ namespace: 'default' }))(ctx(), {
      params: { title: 't', status: 'done' }
    });
    expect(row).toMatchObject({ status: 'closed', resolution: 'completed' });
  });

  it('accepts an explicit sibling that agrees, including by its own alias', async () => {
    const row = await create(new MemoryDataset({ namespace: 'default' }))(ctx(), {
      params: { title: 't', status: 'done', resolution: 'shipped' }
    });
    expect(row).toMatchObject({ status: 'closed', resolution: 'completed' });
  });

  it('rejects an explicit sibling that contradicts the implication', async () => {
    await expect(
      create(new MemoryDataset({ namespace: 'default' }))(ctx(), {
        params: { title: 't', status: 'done', resolution: 'wont_do' }
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'conflicting_implication',
        details: {
          field: 'status',
          value: 'done',
          implies: { resolution: 'completed' },
          conflict: 'resolution'
        }
      })
    );
  });

  it('implies nothing for the canonical value itself', async () => {
    const row = await create(new MemoryDataset({ namespace: 'default' }))(ctx(), {
      params: { title: 't', status: 'closed' }
    });
    expect(row.status).toBe('closed');
    expect(row.resolution).toBeUndefined();
  });

  it('applies on update', async () => {
    const ds = new MemoryDataset({ namespace: 'default' });
    await create(ds)(ctx(), { params: { id: 'x', title: 't', status: 'open' } });
    const row = await updateResolver('Todo', ds, edges(), { fields: TODO })(ctx(), {
      params: { id: 'x', status: 'cancelled' }
    });
    expect(row).toMatchObject({ status: 'closed', resolution: 'wont_do' });
  });

  it('expands an alias filter by its implication', async () => {
    const ds = new MemoryDataset({ namespace: 'default' });
    await create(ds)(ctx(), { params: { id: 'a', title: 't', status: 'done' } });
    await create(ds)(ctx(), { params: { id: 'b', title: 't', status: 'cancelled' } });
    await create(ds)(ctx(), { params: { id: 'c', title: 't', status: 'open' } });
    const list = listResolver('Todo', ds, { fields: TODO });
    const ids = async (where: unknown) =>
      (await list(ctx(), { params: { where } })).rows.map((r) => r.id).sort();
    expect(await ids({ status: { eq: 'done' } })).toEqual(['a']);
    expect(await ids({ status: { eq: 'closed' } })).toEqual(['a', 'b']);
  });

  it('refuses an implication keyed on a value the field does not know', () => {
    expect(() =>
      field.vocab(['open'], { implies: { finished: { resolution: 'completed' } } })
    ).toThrow(/finished/);
  });

  it('refuses, at install, an implication naming a missing field or an illegal value', () => {
    const missing = {
      status: field.vocab(['closed'], {
        aliases: { done: 'closed' },
        implies: { done: { outcome: 'x' } }
      })
    };
    expect(() => assertVocabImplications('Todo', missing)).toThrow(/outcome/);
    const illegal = {
      status: field.vocab(['closed'], {
        aliases: { done: 'closed' },
        implies: { done: { resolution: 'maybe' } }
      }),
      resolution: field.vocab(['completed'])
    };
    expect(() => assertVocabImplications('Todo', illegal)).toThrow(/maybe/);
  });
});

describe('filters over rows stored before normalisation', () => {
  // Rows written before the vocabulary (or an alias) existed keep their old
  // spelling until a backfill rewrites them. Filters must not depend on that
  // backfill having run.
  const TODO: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    status: field.vocab(['open', 'closed'], {
      aliases: { done: 'closed', cancelled: 'closed', not_started: 'open' },
      implies: { done: { resolution: 'completed' }, cancelled: { resolution: 'wont_do' } }
    }),
    resolution: field.vocab(['completed', 'wont_do'], { nullable: true })
  };
  async function legacy() {
    const ds = new MemoryDataset({ namespace: 'default' });
    // Raw dataset writes: no normalisation, exactly what history looks like.
    await ds.write('Todo', [
      { id: 'legacy-done', status: 'done' },
      { id: 'legacy-cancelled', status: 'cancelled' },
      { id: 'legacy-not-started', status: 'not_started' },
      { id: 'new-closed-completed', status: 'closed', resolution: 'completed' },
      { id: 'new-closed-wont', status: 'closed', resolution: 'wont_do' },
      { id: 'new-open', status: 'open' }
    ]);
    const list = listResolver('Todo', ds, { fields: TODO });
    return async (where: unknown) =>
      (await list(ctx(), { params: { where } })).rows.map((r) => r.id).sort();
  }

  it('a canonical eq matches every stored alias of it', async () => {
    const ids = await legacy();
    expect(await ids({ status: { eq: 'closed' } })).toEqual([
      'legacy-cancelled',
      'legacy-done',
      'new-closed-completed',
      'new-closed-wont'
    ]);
  });

  it('nin excludes every stored alias (open work stays open work)', async () => {
    const ids = await legacy();
    expect(await ids({ status: { nin: ['done', 'closed'] } })).toEqual([
      'legacy-not-started',
      'new-open'
    ]);
    expect(await ids({ status: { neq: 'closed' } })).toEqual(['legacy-not-started', 'new-open']);
  });

  it('an implying alias matches its literal legacy rows and the canonical rows that agree', async () => {
    const ids = await legacy();
    expect(await ids({ status: { eq: 'done' } })).toEqual(['legacy-done', 'new-closed-completed']);
    expect(await ids({ status: { eq: 'cancelled' } })).toEqual([
      'legacy-cancelled',
      'new-closed-wont'
    ]);
  });
});
