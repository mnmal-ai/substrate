/**
 * The metadata filter spellings a top-level read accepts (`createdBy`, its
 * `{ kind, id }` form, `createdBy.id`, `_metadata`) work the same inside a
 * walk: a `_walk` where, a where-side and a field `_agg`, and a nested
 * selection's `where` and `orderBy`.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ComposeResult, compose } from '../src/compose.js';

const ctx = { identity: null, now: new Date(), headers: {}, meta: {} };
const NOTE = 'shop/Note.item';
let composed: ComposeResult;

beforeAll(async () => {
  const dataset = new MemoryDataset({ namespace: 'shop', walkReference: true });
  await dataset.write('Item', [
    { id: 'i1', label: 'a' },
    { id: 'i2', label: 'b' }
  ]);
  await dataset.write('Note', [{ id: 'n1', item: 'i1', body: 'x' }], {
    identity: { kind: 'agent', id: 'kid-1' },
    now: new Date('2026-10-02T00:00:00Z')
  });
  await dataset.write('Note', [{ id: 'n3', item: 'i1', body: 'z' }], {
    identity: { kind: 'agent', id: 'kid-0' },
    now: new Date('2026-09-01T00:00:00Z')
  });
  await dataset.write('Note', [{ id: 'n2', item: 'i2', body: 'y' }], {
    identity: { kind: 'agent', id: 'kid-2' },
    now: new Date('2026-10-01T00:00:00Z')
  });
  composed = await compose({
    systemActor: 'test',
    server: new MemorySubstrateServer(),
    dataset,
    datasets: { shop: dataset },
    coordinators: [
      {
        name: 'shop',
        contractVersion: '*',
        namespaces: [
          defineNamespace('shop', {
            Item: { fields: { label: field.string() } },
            Note: { fields: { item: field.crossRef('shop', 'Item'), body: field.string() } }
          })
        ]
      }
    ]
  });
});
afterAll(() => composed.stop());

const query = async (params: Record<string, unknown>, fields: Record<string, unknown>) => {
  const res = await composed.engine.query({ frame: { 'shop/Item': { params, fields } }, ctx });
  expect(res.errors).toBeUndefined();
  return res.data['shop/Item'] as Array<Record<string, unknown>>;
};

const SPELLINGS: Array<[string, Record<string, unknown>]> = [
  ['createdBy eq', { createdBy: { eq: 'kid-1' } }],
  ['createdBy { kind, id }', { createdBy: { eq: { kind: 'agent', id: 'kid-1' } } }],
  ['createdBy.id', { 'createdBy.id': { eq: 'kid-1' } }],
  ['_metadata createdAt', { _metadata: { createdAt: { gt: '2026-10-01T12:00:00Z' } } }]
];

describe('metadata filter spellings inside walks', () => {
  it.each(SPELLINGS)('%s in a _walk where', async (_n, where) => {
    const rows = await query({ where: { _walk: { in: NOTE, where } } }, { id: true });
    expect(rows.map((r) => r.id)).toEqual(['i1']);
  });

  it.each(SPELLINGS)('%s in a where-side _agg', async (_n, where) => {
    const rows = await query(
      { where: { _agg: { in: NOTE, where, count: true }, gte: 1 } },
      {
        id: true
      }
    );
    expect(rows.map((r) => r.id)).toEqual(['i1']);
  });

  it.each(SPELLINGS)('%s in a field _agg', async (_n, where) => {
    const rows = await query(
      { orderBy: [{ label: 'asc' }] },
      { id: true, _agg: { mine: { in: NOTE, where, count: true } } }
    );
    expect(rows.map((r) => (r._agg as { mine: number }).mine)).toEqual([1, 0]);
  });

  it.each(SPELLINGS)('%s in a nested selection where', async (_n, where) => {
    const rows = await query(
      { orderBy: [{ label: 'asc' }] },
      { id: true, notes: { _walk: { in: NOTE }, where, fields: { body: true } } }
    );
    expect(rows.map((r) => (r.notes as Array<{ body: string }>).map((n) => n.body))).toEqual([
      ['x'],
      []
    ]);
  });

  it.each([
    [[{ createdBy: 'desc' }], ['x', 'z']],
    [[{ 'createdBy.id': 'asc' }], ['z', 'x']],
    [[{ '_metadata.createdAt': 'desc' }], ['x', 'z']]
  ])('orderBy %j orders a nested selection', async (orderBy, bodies) => {
    const rows = await query(
      { orderBy: [{ label: 'asc' }] },
      { id: true, notes: { _walk: { in: NOTE }, orderBy, fields: { body: true } } }
    );
    const notes = (rows[0]?.notes ?? []) as Array<{ body: string }>;
    expect(notes.map((n) => n.body)).toEqual(bodies);
  });
});
