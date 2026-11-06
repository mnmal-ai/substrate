import type { FieldDef, PackEnvelope } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { listHooks, RELATED_K } from '../src/ask/list.js';
import { parseTui } from '../src/ask/present.js';
import { type RowsReply, rowsList } from '../src/ask/render.js';
import type { TuiDeps } from '../src/deps.js';

const reply = (data: unknown, extra: Partial<RowsReply> = {}): RowsReply => ({
  kind: 'rows',
  frame: {
    'shop/Product': { params: { where: { inStock: { eq: true } } }, fields: {} }
  },
  answer: 'rows',
  source: 'parser',
  dropped: [],
  plan: [],
  data,
  ...extra
});

describe('rowsList', () => {
  it('maps a declared type: title, tags then details, value with its format', () => {
    const view = parseTui({
      formats: { 'Product.price': 'money', 'Product.stock': 'int' },
      rows: {
        Product: { title: 'productName', tags: ['colour'], value: 'price', details: ['stock'] }
      }
    }).types.Product;
    const list = rowsList(
      reply([{ id: 'p1', productName: 'Desk lamp', colour: 'red', price: 129.5, stock: 3 }], {
        ...(view !== undefined ? { tui: view } : {})
      })
    );
    expect(list).toEqual({
      heading: 'shop/Product',
      rows: [{ key: 'p1', name: 'Desk lamp', details: ['red', 'stock 3'], value: '$129.50' }]
    });
  });

  it('maps a generic type: the label, then asked-about fields before the rest', () => {
    const list = rowsList(
      reply([
        { id: 'p1', shortId: 7, productName: 'Kettle', colour: 'red', inStock: true, tags: ['a'] }
      ])
    );
    expect(list?.rows).toEqual([
      { key: 'p1', name: 'Kettle', details: ['inStock=true', 'colour=red'] }
    ]);
  });

  it('keys an id-less row by position, and carries dropped spans and errors as notes', () => {
    const list = rowsList(
      reply([{ productName: 'Kettle' }], {
        dropped: [{ span: 'cheap', reason: 'no price field' }] as RowsReply['dropped']
      })
    );
    expect(list?.rows[0]?.key).toBe('0');
    expect(list?.notes).toEqual(['dropped "cheap": no price field']);
  });

  it('is not a list for a count, an aggregate or a rejected frame', () => {
    expect(rowsList(reply({ count: 3 }, { count: 3 }))).toBeUndefined();
    expect(
      rowsList(
        reply([], {
          aggregate: { fn: 'sum', field: 'price', value: 1 } as NonNullable<RowsReply['aggregate']>
        })
      )
    ).toBeUndefined();
    expect(rowsList(reply(undefined))).toBeUndefined();
  });
});

const FIELDS: Record<string, FieldDef> = {
  title: { kind: 'scalar', type: 'string' },
  status: { kind: 'scalar', type: 'string' },
  project: { kind: 'scalar', type: 'string' },
  body: { kind: 'scalar', type: 'string' },
  notes: { kind: 'scalar', type: 'string' },
  extra: { kind: 'scalar', type: 'json' }
} as Record<string, FieldDef>;

function stub(answer: (frame: Record<string, unknown>) => Partial<PackEnvelope>) {
  const frames: Record<string, unknown>[] = [];
  const deps = {
    query: async (frame: Record<string, unknown>) => {
      frames.push(frame);
      return { schemaVersion: 'v', data: {}, shapes: {}, ...answer(frame) } as PackEnvelope;
    }
  } as unknown as TuiDeps;
  return { deps, frames };
}
const ROW = { key: 't1', name: 'Ship it' };
const TODO = {
  id: 't1',
  title: 'Ship it',
  status: 'open',
  project: 'coda',
  body: 'The body.',
  notes: 'A note.'
};

describe('listHooks', () => {
  it('open reads the record by id with every non-json scalar field', async () => {
    const { deps, frames } = stub(() => ({ data: { 'journal/Todo': [TODO] } }));
    const hooks = listHooks(deps, 'journal', 'Todo', FIELDS, new Map([['t1', { id: 't1' }]]));
    expect(await hooks.open?.(ROW)).toEqual({
      title: 'Ship it',
      meta: 'open · coda',
      body: 'The body.\n\nA note.'
    });
    expect(frames[0]).toEqual({
      'journal/Todo': {
        params: { where: { id: { eq: 't1' } }, limit: 1 },
        fields: { id: true, title: true, status: true, project: true, body: true, notes: true }
      }
    });
  });

  it('open throws the server reason for a refused frame, and Enter again retries', async () => {
    let n = 0;
    const { deps } = stub(() =>
      n++ === 0 ? { errors: [{ message: 'not authorised' }] } : { data: { 'journal/Todo': [TODO] } }
    );
    const hooks = listHooks(deps, 'journal', 'Todo', FIELDS, new Map([['t1', { id: 't1' }]]));
    await expect(hooks.open?.(ROW)).rejects.toThrow('not authorised');
    await expect(hooks.open?.(ROW)).resolves.toMatchObject({ title: 'Ship it' });
  });

  it('open shows an id-less row as the answer carried it, without a read', async () => {
    const { deps, frames } = stub(() => ({}));
    const hooks = listHooks(
      deps,
      'shop',
      'Product',
      undefined,
      new Map([['0', { productName: 'Kettle', price: 12 }]])
    );
    expect(await hooks.open?.({ key: '0', name: 'Kettle' })).toEqual({
      title: 'Kettle',
      body: 'price: 12'
    });
    expect(frames).toHaveLength(0);
  });

  it('related recalls over the same type and namespace, leaves the row out and scores to 2 dp', async () => {
    const hits = Array.from({ length: RELATED_K + 1 }, (_, i) => ({
      id: i === 0 ? 't1' : `h${i}`,
      score: 0.9 - i / 100,
      row: { id: `h${i}`, title: `hit ${i}` }
    }));
    const { deps, frames } = stub((f) =>
      'recall/Hit' in f ? { data: { 'recall/Hit': hits } } : { data: { 'journal/Todo': [TODO] } }
    );
    const hooks = listHooks(deps, 'journal', 'Todo', FIELDS, new Map([['t1', { id: 't1' }]]));
    const list = await hooks.related?.(ROW);
    expect(frames.at(-1)).toEqual({
      'recall/Hit': {
        params: { to: 'Ship it\nThe body.', namespace: 'journal', type: 'Todo', k: RELATED_K + 1 },
        fields: { id: true, score: true, row: true }
      }
    });
    expect(list?.heading).toBe('related to Ship it');
    expect(list?.rows).toHaveLength(RELATED_K);
    expect(list?.rows.some((r) => r.key === 't1')).toBe(false);
    expect(list?.rows[0]).toEqual({ key: 'h1', name: 'hit 1', value: '0.89' });
  });
});
