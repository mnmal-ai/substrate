/**
 * serverSet date fields are never stamped by autoCRUD, and clients may not
 * supply them in their gated phase. A non-nullable, non-defaulted field gated
 * on create can therefore never be filled by autoCRUD create, and is refused
 * when the type is defined or installed.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { createResolver, installAutoCrud } from '../src/autocrud/index.js';
import { field } from '../src/field.js';
import { defineNamespace } from '../src/namespace.js';

function makeCtx(): RequestContext {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    namespace: 'app',
    operation: 'mutate',
    now: new Date('2026-04-25T00:00:00Z'),
    headers: {},
    meta: {}
  };
}

describe('defineNamespace — unfillable serverSet fields', () => {
  for (const phase of ['create', 'both'] as const) {
    it(`rejects a non-nullable serverSet:'${phase}' date field`, () => {
      expect(() =>
        defineNamespace('app', {
          Thing: { fields: { stampedAt: field.date({ serverSet: phase }) } }
        })
      ).toThrow(/stampedAt.*Thing|Thing.*stampedAt/);
    });
  }

  it('accepts a nullable serverSet:both date field (server code stamps it later)', () => {
    expect(() =>
      defineNamespace('app', {
        Thing: { fields: { approvedAt: field.date({ nullable: true, serverSet: 'both' }) } }
      })
    ).not.toThrow();
  });

  it('accepts a non-nullable serverSet:update date field (clients supply it on create)', () => {
    expect(() =>
      defineNamespace('app', {
        Thing: { fields: { touchedAt: field.date({ serverSet: 'update' }) } }
      })
    ).not.toThrow();
  });

  it('ignores autoCrud:false types (their own resolvers own the write path)', () => {
    expect(() =>
      defineNamespace('app', {
        Thing: { autoCrud: false, fields: { stampedAt: field.date({ serverSet: 'create' }) } }
      })
    ).not.toThrow();
  });
});

describe('installAutoCrud — unfillable serverSet fields', () => {
  it('rejects a non-nullable serverSet:create date field', () => {
    const fields: Record<string, FieldDef> = {
      stampedAt: { kind: 'scalar', type: 'date', serverSet: 'create' }
    };
    expect(() =>
      installAutoCrud(
        new Registry(),
        'Thing',
        new MemoryDataset({ namespace: 'app' }),
        new MemoryEdgesStore({ now: () => new Date() }),
        { fields }
      )
    ).toThrow(/stampedAt/);
  });
});

describe('create — required check covers serverSet:update fields', () => {
  it('rejects a create that omits a non-nullable serverSet:update date field', async () => {
    const fields: Record<string, FieldDef> = {
      name: { kind: 'scalar', type: 'string' },
      touchedAt: { kind: 'scalar', type: 'date', serverSet: 'update' }
    };
    const resolver = createResolver('Thing', new MemoryDataset({ namespace: 'app' }), {
      fields
    });
    await expect(resolver(makeCtx(), { params: { name: 'x' } })).rejects.toThrow(
      expect.objectContaining({ code: 'missing_required_field' })
    );
  });
});
