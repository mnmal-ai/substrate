/**
 * AutoCRUD reject path for client-supplied server fields.
 *
 * Verifies that autoCRUD hard-rejects:
 *   Tier-1: row metadata fields (createdAt, updatedAt, createdBy, updatedBy)
 *   Tier-2: opt-in serverSet date fields
 */

import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, RequestContext } from '@mnmal-ai/substrate-types';
import { CLIENT_SUPPLIED_SERVER_FIELD } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  createResolver,
  deleteResolver,
  getResolver,
  purgeResolver,
  updateResolver
} from '../src/autocrud/index.js';
import { assertCrossRefDeletePolicies } from '../src/autocrud/internal.js';

/** Minimal fields map for the Thing type under test. */
const THING_FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  name: { kind: 'scalar', type: 'string' },
  processedAt: { kind: 'scalar', type: 'date', nullable: true, serverSet: 'create' },
  lastTouchedAt: { kind: 'scalar', type: 'date', nullable: true, serverSet: 'update' }
};

/**
 * None of these fixtures declare a crossRef field, so `updateResolver` never
 * dereferences this store — it just needs a valid `EdgesStore` to satisfy the
 * constructor param shared with `createResolverWithEdges`.
 */
function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-25T00:00:00Z') });
}

function makeCtx(): RequestContext {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    namespace: 'default',
    operation: 'mutate',
    now: new Date('2026-04-25T00:00:00Z'),
    headers: {},
    meta: {}
  };
}

describe('autoCRUD reject — client-supplied server fields', () => {
  it('rejects client-supplied createdAt on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { name: 'x', createdAt: '2020-01-01T00:00:00Z' } })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('rejects client-supplied updatedAt on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { name: 'x', updatedAt: '2020-01-01T00:00:00Z' } })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('rejects client-supplied createdBy on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { name: 'x', createdBy: { id: 'u1', kind: 'user' } } })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('rejects client-supplied serverSet=create field on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { name: 'x', processedAt: '2020-01-01T00:00:00Z' } })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('rejects client-supplied createdAt on update', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    // Create a row first
    await createResolver('Thing', dataset, { fields: THING_FIELDS })(makeCtx(), {
      params: { id: 'thing-1', name: 'original' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), {
        params: { id: 'thing-1', name: 'y', createdAt: '2020-01-01T00:00:00Z' }
      })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('allows non-rejected fields through on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    const row = await resolver(makeCtx(), { params: { name: 'x' } });
    expect(row).toMatchObject({ name: 'x' });
  });

  it('rejects client-supplied updatedBy on create (Tier-1, completes the matrix)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { name: 'x', updatedBy: { id: 'u1', kind: 'user' } } })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('rejects client-supplied serverSet=update field on update (phase gate fires)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: THING_FIELDS })(makeCtx(), {
      params: { id: 'thing-2', name: 'original' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), {
        params: { id: 'thing-2', name: 'y', lastTouchedAt: '2020-01-01T00:00:00Z' }
      })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('does NOT reject serverSet=create field on update (phase gate does not fire)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: THING_FIELDS })(makeCtx(), {
      params: { id: 'thing-3', name: 'original' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    // processedAt is serverSet:'create' — on update, client values pass through (no reject)
    const row = await resolver(makeCtx(), {
      params: { id: 'thing-3', name: 'y', processedAt: '2020-01-01T00:00:00Z' }
    });
    expect(row).toMatchObject({ id: 'thing-3', name: 'y' });
  });

  it('rejects client-supplied _metadata on create (Tier-0 reserved row field)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), {
        params: {
          name: 'x',
          _metadata: {
            createdAt: '2020-01-01T00:00:00Z',
            updatedAt: '2020-01-01T00:00:00Z',
            createdBy: { kind: 'user', id: 'forged' },
            updatedBy: { kind: 'user', id: 'forged' }
          }
        }
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: CLIENT_SUPPLIED_SERVER_FIELD,
        details: { field: '_metadata', phase: 'create' }
      })
    );
  });

  it('rejects client-supplied _metadata on update (same Tier-0 path on update phase)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: THING_FIELDS })(makeCtx(), {
      params: { id: 'thing-meta', name: 'original' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    await expect(
      resolver(makeCtx(), {
        params: {
          id: 'thing-meta',
          name: 'y',
          _metadata: {
            createdAt: null,
            updatedAt: '2020-01-01T00:00:00Z',
            createdBy: null,
            updatedBy: { kind: 'user', id: 'forged' }
          }
        }
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: CLIENT_SUPPLIED_SERVER_FIELD,
        details: { field: '_metadata', phase: 'update' }
      })
    );
  });

  it('ResolverFrameError carries structured details payload', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: THING_FIELDS });
    // Each tier of rejection populates `details.field` so callers can branch
    // on the rejected field name without parsing the prose message.
    await expect(
      resolver(makeCtx(), { params: { name: 'x', createdAt: '2020-01-01T00:00:00Z' } })
    ).rejects.toThrow(
      expect.objectContaining({
        code: CLIENT_SUPPLIED_SERVER_FIELD,
        details: { field: 'createdAt', phase: 'create' }
      })
    );
  });
});

describe('autoCRUD reject — out-of-vocab enum values', () => {
  const ENUM_FIELDS: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    name: { kind: 'scalar', type: 'string' },
    status: { kind: 'scalar', type: 'string', enum: ['open', 'done'], nullable: true }
  };

  it('rejects an out-of-vocab value on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: ENUM_FIELDS });
    await expect(resolver(makeCtx(), { params: { name: 'x', status: 'nope' } })).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_enum_value' })
    );
  });

  it('accepts an in-vocab value on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: ENUM_FIELDS });
    const row = await resolver(makeCtx(), { params: { name: 'x', status: 'open' } });
    expect(row.status).toBe('open');
  });

  it('skips validation when the enum value is null (nullable enum)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: ENUM_FIELDS });
    const row = await resolver(makeCtx(), { params: { name: 'x', status: null } });
    expect(row.name).toBe('x');
  });

  it('skips validation when the enum field is absent on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: ENUM_FIELDS });
    const row = await resolver(makeCtx(), { params: { name: 'x' } });
    expect(row.name).toBe('x');
  });

  it('rejects an out-of-vocab value on update', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: ENUM_FIELDS })(makeCtx(), {
      params: { id: 'thing-1', name: 'original', status: 'open' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: ENUM_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { id: 'thing-1', status: 'bogus' } })
    ).rejects.toThrow(expect.objectContaining({ code: 'invalid_enum_value' }));
  });

  it('allows updating a non-enum field without re-validating the absent enum', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: ENUM_FIELDS })(makeCtx(), {
      params: { id: 'thing-2', name: 'original', status: 'open' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: ENUM_FIELDS });
    const row = await resolver(makeCtx(), { params: { id: 'thing-2', name: 'updated' } });
    expect(row?.name).toBe('updated');
  });

  it('rejects a non-string value for a string enum on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: ENUM_FIELDS });
    await expect(resolver(makeCtx(), { params: { name: 'x', status: 42 } })).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_enum_value' })
    );
  });

  it('accepts an in-vocab value on update', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: ENUM_FIELDS })(makeCtx(), {
      params: { id: 'thing-3', name: 'original', status: 'open' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: ENUM_FIELDS });
    const row = await resolver(makeCtx(), { params: { id: 'thing-3', status: 'done' } });
    expect(row?.status).toBe('done');
  });
});

describe('autoCRUD reject — missing params.id', () => {
  // The id-requiring resolvers must throw a ResolverFrameError (code:
  // 'missing_id') so the engine surfaces a clean validation error rather than
  // letting a bare Error fall through to internal_error / HTTP 500. Same
  // contract as the unknown_param / invalid_enum_value rejections above.
  it('updateResolver rejects missing id with code missing_id + field detail', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: THING_FIELDS });
    await expect(resolver(makeCtx(), { params: {} })).rejects.toThrow(
      expect.objectContaining({ code: 'missing_id', details: { field: 'id' } })
    );
  });

  it('getResolver rejects missing id with code missing_id', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = getResolver('Thing', dataset);
    await expect(resolver(makeCtx(), { params: {} })).rejects.toThrow(
      expect.objectContaining({ code: 'missing_id' })
    );
  });

  it('deleteResolver rejects missing id with code missing_id', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-25T00:00:00Z') });
    const resolver = deleteResolver('Thing', dataset, edges);
    await expect(resolver(makeCtx(), { params: {} })).rejects.toThrow(
      expect.objectContaining({ code: 'missing_id' })
    );
  });

  it('purgeResolver rejects missing id with code missing_id', async () => {
    const prev = process.env.SUBSTRATE_HARD_DELETE;
    process.env.SUBSTRATE_HARD_DELETE = 'allow'; // purge gates on hard-delete before the id check
    try {
      const dataset = new MemoryDataset({ namespace: 'default' });
      const resolver = purgeResolver('Thing', dataset);
      await expect(resolver(makeCtx(), { params: {} })).rejects.toThrow(
        expect.objectContaining({ code: 'missing_id' })
      );
    } finally {
      if (prev === undefined) delete process.env.SUBSTRATE_HARD_DELETE;
      else process.env.SUBSTRATE_HARD_DELETE = prev;
    }
  });
});

describe('autoCRUD reject — undeclared body fields', () => {
  // The declared FieldDef map IS the write contract. A top-level key not in it
  // (a typo, or a stale name after a field rename) must fail loud, not be
  // silently spread into the row body. `id` is always allowed; struct interiors
  // are intentionally open and must NOT be inspected.
  const STRUCT_FIELDS: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    name: { kind: 'scalar', type: 'string' },
    meta: { kind: 'struct', fields: { kind: { kind: 'scalar', type: 'string' } } }
  };

  it('rejects an undeclared field on create with code unknown_field + field detail', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: STRUCT_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { name: 'x', synopsis: 'stale-rename' } })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'unknown_field',
        details: expect.objectContaining({ field: 'synopsis', phase: 'create' })
      })
    );
  });

  it('rejects Object.prototype names as undeclared fields', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: STRUCT_FIELDS });
    for (const key of ['toString', 'constructor']) {
      await expect(resolver(makeCtx(), { params: { name: 'x', [key]: 'y' } })).rejects.toThrow(
        expect.objectContaining({ code: 'unknown_field' })
      );
    }
  });

  it('rejects an undeclared field on update with code unknown_field', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: STRUCT_FIELDS })(makeCtx(), {
      params: { id: 'thing-1', name: 'original' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: STRUCT_FIELDS });
    await expect(
      resolver(makeCtx(), { params: { id: 'thing-1', text: 'legacy-key' } })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'unknown_field',
        details: expect.objectContaining({ field: 'text', phase: 'update' })
      })
    );
  });

  it('allows declared fields plus id on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: STRUCT_FIELDS });
    const row = await resolver(makeCtx(), { params: { id: 'thing-ok', name: 'x' } });
    expect(row).toMatchObject({ id: 'thing-ok', name: 'x' });
  });

  it('does NOT inspect struct interiors — arbitrary nested keys pass (additive growth)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: STRUCT_FIELDS });
    const row = await resolver(makeCtx(), {
      params: { name: 'x', meta: { kind: 'agent', undeclaredNested: 'fine' } }
    });
    expect(row).toMatchObject({ name: 'x', meta: { kind: 'agent', undeclaredNested: 'fine' } });
  });

  it('server-controlled fields keep their specific code (ordering — guard runs last)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: STRUCT_FIELDS });
    // createdAt is undeclared in STRUCT_FIELDS, so without correct ordering this
    // would surface as unknown_field. assertNoClientServerFields must win.
    await expect(
      resolver(makeCtx(), { params: { name: 'x', createdAt: '2020-01-01T00:00:00Z' } })
    ).rejects.toThrow(expect.objectContaining({ code: CLIENT_SUPPLIED_SERVER_FIELD }));
  });

  it('skips the guard when no fields map is supplied (untyped resolver)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset);
    const row = await resolver(makeCtx(), { params: { anything: 'goes' } });
    expect(row).toMatchObject({ anything: 'goes' });
  });
});

describe('autoCRUD — scalar defaults + required fields', () => {
  // title: required (non-nullable, no default). archived: defaulted. note: optional (nullable).
  const FIELDS: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    title: { kind: 'scalar', type: 'string' },
    archived: { kind: 'scalar', type: 'boolean', default: false },
    note: { kind: 'scalar', type: 'string', nullable: true }
  };

  it('fills a scalar default when the field is omitted on create', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: FIELDS });
    const row = await resolver(makeCtx(), { params: { title: 'x' } });
    expect((row as { archived?: boolean }).archived).toBe(false);
  });

  it('caller-supplied value wins over the default', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: FIELDS });
    const row = await resolver(makeCtx(), { params: { title: 'x', archived: true } });
    expect((row as { archived?: boolean }).archived).toBe(true);
  });

  it('rejects create missing a required field (non-nullable, no default)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: FIELDS });
    await expect(resolver(makeCtx(), { params: { archived: true } })).rejects.toThrow(
      expect.objectContaining({
        code: 'missing_required_field',
        details: expect.objectContaining({ field: 'title', phase: 'create' })
      })
    );
  });

  it('names EVERY missing required field, not just the first — one bad create is one round-trip', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const fields = {
      ...FIELDS,
      subtitle: { kind: 'scalar', type: 'string' } as FieldDef,
      slug: { kind: 'scalar', type: 'string' } as FieldDef
    };
    const resolver = createResolver('Thing', dataset, { fields });
    await expect(resolver(makeCtx(), { params: {} })).rejects.toThrow(
      expect.objectContaining({
        code: 'missing_required_field',
        details: expect.objectContaining({
          field: 'title',
          fields: ['title', 'subtitle', 'slug'],
          phase: 'create'
        })
      })
    );
  });

  it('the MESSAGE carries every missing name — details are not always what a caller sees', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const fields = { ...FIELDS, subtitle: { kind: 'scalar', type: 'string' } as FieldDef };
    const resolver = createResolver('Thing', dataset, { fields });
    await expect(resolver(makeCtx(), { params: {} })).rejects.toThrow(/'title', 'subtitle'/);
  });

  it('a single missing field still reads in the singular', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: FIELDS });
    await expect(resolver(makeCtx(), { params: { archived: true } })).rejects.toThrow(
      /required field 'title'/
    );
  });

  it('a nullable field is not required — omission is fine', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: FIELDS });
    const row = await resolver(makeCtx(), { params: { title: 'x' } });
    expect(row).toMatchObject({ title: 'x' });
  });

  it('does not require id (engine-generated when omitted)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Thing', dataset, { fields: FIELDS });
    const row = await resolver(makeCtx(), { params: { title: 'x' } });
    expect(typeof (row as { id?: string }).id).toBe('string');
  });

  it('update neither requires fields nor fills defaults (partial patch)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await createResolver('Thing', dataset, { fields: FIELDS })(makeCtx(), {
      params: { id: 'r1', title: 'original' }
    });
    const resolver = updateResolver('Thing', dataset, makeEdges(), { fields: FIELDS });
    // No `title` in the patch — must NOT trip missing_required_field.
    const row = await resolver(makeCtx(), { params: { id: 'r1', note: 'hi' } });
    expect(row).toMatchObject({ id: 'r1', note: 'hi' });
  });

  // A present key holding null/undefined passed the presence-only check.
  describe('null and undefined on a non-nullable field', () => {
    const create = () =>
      createResolver('Thing', new MemoryDataset({ namespace: 'default' }), {
        fields: FIELDS
      });
    const refusedNull = (field: string, phase: 'create' | 'update') =>
      expect.objectContaining({
        code: 'null_not_allowed',
        details: expect.objectContaining({ field, phase })
      });

    it('create refuses an explicit null on a required field', async () => {
      await expect(create()(makeCtx(), { params: { title: null } })).rejects.toThrow(
        refusedNull('title', 'create')
      );
    });

    it('create refuses an explicit null on a defaulted non-nullable field', async () => {
      await expect(create()(makeCtx(), { params: { title: 'x', archived: null } })).rejects.toThrow(
        refusedNull('archived', 'create')
      );
    });

    it('create treats undefined as omitted: required is refused, defaults still fill', async () => {
      await expect(create()(makeCtx(), { params: { title: undefined } })).rejects.toThrow(
        expect.objectContaining({ code: 'missing_required_field' })
      );
      const row = await create()(makeCtx(), { params: { title: 'x', archived: undefined } });
      expect((row as { archived?: boolean }).archived).toBe(false);
    });

    it('create still accepts null on a nullable field', async () => {
      const row = await create()(makeCtx(), { params: { title: 'x', note: null } });
      expect(row).toMatchObject({ title: 'x', note: null });
    });

    it('update refuses setting a non-nullable field to null, and leaves the row intact', async () => {
      const dataset = new MemoryDataset({ namespace: 'default' });
      await createResolver('Thing', dataset, { fields: FIELDS })(makeCtx(), {
        params: { id: 'r1', title: 'original' }
      });
      const update = updateResolver('Thing', dataset, makeEdges(), { fields: FIELDS });
      await expect(update(makeCtx(), { params: { id: 'r1', title: null } })).rejects.toThrow(
        refusedNull('title', 'update')
      );
      const row = await update(makeCtx(), { params: { id: 'r1', note: 'n' } });
      expect(row).toMatchObject({ title: 'original', note: 'n' });
    });

    it('update treats undefined as unsent, and still clears a nullable field with null', async () => {
      const dataset = new MemoryDataset({ namespace: 'default' });
      await createResolver('Thing', dataset, { fields: FIELDS })(makeCtx(), {
        params: { id: 'r1', title: 'original', note: 'n' }
      });
      const update = updateResolver('Thing', dataset, makeEdges(), { fields: FIELDS });
      const row = await update(makeCtx(), { params: { id: 'r1', title: undefined, note: null } });
      expect(row).toMatchObject({ title: 'original', note: null });
    });
  });
});

describe('autoCRUD — required crossRefs', () => {
  // task: cascade with nullable unset, so required. parent: set_null with nullable unset, so optional.
  const FIELDS: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    title: { kind: 'scalar', type: 'string', nullable: true },
    task: { kind: 'crossRef', ns: 'default', type: 'Task', onDelete: 'cascade' },
    parent: { kind: 'crossRef', ns: 'default', type: 'Thing', onDelete: 'set_null' }
  };

  it('create refuses omitting a non-nullable crossRef', async () => {
    const resolver = createResolver('Thing', new MemoryDataset({ namespace: 'default' }), {
      fields: FIELDS
    });
    await expect(resolver(makeCtx(), { params: { title: 'x' } })).rejects.toThrow(
      expect.objectContaining({
        code: 'missing_required_field',
        details: expect.objectContaining({ fields: ['task'], phase: 'create' })
      })
    );
  });

  it('create refuses an explicit null on a non-nullable crossRef', async () => {
    const resolver = createResolver('Thing', new MemoryDataset({ namespace: 'default' }), {
      fields: FIELDS
    });
    await expect(resolver(makeCtx(), { params: { task: null } })).rejects.toThrow(
      expect.objectContaining({
        code: 'null_not_allowed',
        details: expect.objectContaining({ field: 'task' })
      })
    );
  });

  it('nullable crossRefs, explicitly or by onDelete set_null, may be omitted', async () => {
    const fields = { ...FIELDS, task: { ...FIELDS.task, nullable: true } as FieldDef };
    const resolver = createResolver('Thing', new MemoryDataset({ namespace: 'default' }), {
      fields
    });
    const row = await resolver(makeCtx(), { params: { title: 'x' } });
    expect(row).toMatchObject({ title: 'x' });
  });

  it('update refuses nulling a non-nullable crossRef', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Thing', [{ id: 'r1', title: 'x', task: 't1' }]);
    const update = updateResolver('Thing', dataset, makeEdges(), { fields: FIELDS });
    await expect(update(makeCtx(), { params: { id: 'r1', task: null } })).rejects.toThrow(
      expect.objectContaining({
        code: 'null_not_allowed',
        details: expect.objectContaining({ phase: 'update' })
      })
    );
  });

  it('registration refuses nullable: false with onDelete set_null', () => {
    expect(() =>
      assertCrossRefDeletePolicies('Thing', {
        parent: {
          kind: 'crossRef',
          ns: 'default',
          type: 'Thing',
          onDelete: 'set_null',
          nullable: false
        }
      })
    ).toThrow(/'parent'.*nullable: false but onDelete: 'set_null'/);
    expect(() => assertCrossRefDeletePolicies('Thing', FIELDS)).not.toThrow();
  });
});

describe('autoCRUD reject — values that do not match a scalar field type', () => {
  // Postgres sorts and date-filters these by casting body->>field to numeric,
  // timestamptz or boolean, so one bad stored value breaks every such read of
  // the type for everyone.
  const TYPED: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    count: { kind: 'scalar', type: 'number', nullable: true },
    done: { kind: 'scalar', type: 'boolean', nullable: true },
    dueAt: { kind: 'scalar', type: 'date', nullable: true }
  };
  const setup = () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    return {
      create: createResolver('Typed', dataset, { fields: TYPED }),
      update: updateResolver('Typed', dataset, makeEdges(), { fields: TYPED })
    };
  };

  for (const [field, value] of [
    ['count', 'abc'],
    ['count', Number.NaN],
    ['done', 'yes'],
    ['dueAt', 'next week'],
    ['dueAt', ''],
    // JS Date accepts these; pg's timestamptz input does not.
    ['dueAt', '1'],
    ['dueAt', 'Oct 21 2026'],
    ['dueAt', '2026-02-30'],
    ['dueAt', '2026-10-21T24:30:00Z'],
    ['dueAt', '0000-01-01'],
    ['dueAt', '2026-01-01T00:00:00+16:00']
  ] as const) {
    it(`refuses ${field}: ${JSON.stringify(value)} on create and update`, async () => {
      const { create, update } = setup();
      await expect(create(makeCtx(), { params: { [field]: value } })).rejects.toThrow(
        expect.objectContaining({ code: 'invalid_field_type' })
      );
      await create(makeCtx(), { params: { id: 'r1' } });
      await expect(update(makeCtx(), { params: { id: 'r1', [field]: value } })).rejects.toThrow(
        expect.objectContaining({ code: 'invalid_field_type' })
      );
    });
  }

  it('accepts well-typed values and null on a nullable field', async () => {
    const { create } = setup();
    await expect(
      create(makeCtx(), {
        params: { count: 3, done: false, dueAt: '2026-10-21T10:00:00.123456Z' }
      })
    ).resolves.toBeDefined();
    // Edge cases pg accepts: a leap day in year 4 and the widest offset.
    for (const dueAt of ['0004-02-29', '2026-01-01T00:00:00-15:59', '2026-10-21T10:00:00+0530']) {
      await expect(create(makeCtx(), { params: { dueAt } })).resolves.toBeDefined();
    }
    await expect(
      create(makeCtx(), { params: { count: null, done: null, dueAt: null } })
    ).resolves.toBeDefined();
  });
});
