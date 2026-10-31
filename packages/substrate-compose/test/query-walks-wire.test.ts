/**
 * Walk results reach clients: a `count`, `groups` and a nested list cut to
 * its limit come back through `/substrate/v1/query` the same on JSON and on
 * the positional substrate-pack wire.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { decodeEnvelope, PACK_MIME, unpackFrame } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { FieldInput, PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

const FRAME = {
  'shop/Item': { params: { count: true } },
  'shop/Note': {
    params: { aggregate: { n: { count: true } }, bucket: { field: 'at', by: 'day' } }
  }
};

describe('/substrate/v1/query walk results', () => {
  it('count, groups and a truncated nested list match on JSON and pack', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'shop', walkReference: true });
    await dataset.write('Item', [
      { id: 'i1', label: 'a' },
      { id: 'i2', label: 'b' }
    ]);
    await dataset.write('Note', [
      { id: 'n1', item: 'i1', body: 'x', at: new Date('2026-10-24T01:00:00Z') },
      { id: 'n2', item: 'i1', body: 'y', at: new Date('2026-10-24T02:00:00Z') },
      { id: 'n3', item: 'i2', body: 'z', at: new Date('2026-10-25T01:00:00Z') }
    ]);
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      datasets: { shop: dataset },
      walksEnabled: true,
      coordinators: [
        {
          name: 'shop',
          contractVersion: '*',
          namespaces: [
            defineNamespace('shop', {
              Item: { fields: { label: field.string() } },
              Note: {
                fields: {
                  item: field.crossRef('shop', 'Item'),
                  body: field.string(),
                  at: field.date()
                }
              }
            })
          ]
        }
      ]
    });
    await server.start();
    const nestedFields = {
      label: true,
      _agg: { notes: { in: 'shop/Note.item', count: true } },
      notes: {
        _walk: { in: 'shop/Note.item' },
        fields: { body: true },
        orderBy: [{ body: 'asc' }],
        limit: 1
      }
    };
    // Two frames on one type need two requests: one key per type per frame.
    const frames = [
      { 'shop/Item': FRAME['shop/Item'], 'shop/Note': FRAME['shop/Note'] },
      { 'shop/Item': { params: { orderBy: [{ label: 'asc' }] }, fields: nestedFields } }
    ];
    const post = (frame: unknown, pack: boolean) =>
      server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: {
          'content-type': 'application/json',
          ...(pack ? { accept: PACK_MIME } : {})
        },
        body: Buffer.from(JSON.stringify(frame))
      });
    try {
      const [aggJson, nestedJson] = await Promise.all(
        frames.map(async (f) => JSON.parse(String((await post(f, false)).body)) as PackEnvelope)
      );
      expect(aggJson?.errors).toBeUndefined();
      expect(aggJson?.data['shop/Item']).toEqual({ count: 2 });
      expect(aggJson?.shapes['shop/Item']).toBe('count');
      expect(aggJson?.data['shop/Note']).toEqual({
        groups: [
          { bucket: '2026-10-24', n: 2 },
          { bucket: '2026-10-25', n: 1 }
        ]
      });
      expect(aggJson?.shapes['shop/Note']).toBe('groups');

      expect(nestedJson?.errors).toBeUndefined();
      expect(nestedJson?.data['shop/Item']).toEqual([
        {
          label: 'a',
          _agg: { notes: 2 },
          notes: [{ id: 'n1', body: 'x' }],
          _truncated: { notes: true }
        },
        { label: 'b', _agg: { notes: 1 }, notes: [{ id: 'n3', body: 'z' }] }
      ]);

      const schemas = composed.engine.federatedSchema();
      for (const [i, f] of frames.entries()) {
        const res = await post(f, true);
        const fieldsByKey: Record<string, FieldInput> = {};
        const typeByKey: Record<string, string> = {};
        const currentNsByKey: Record<string, string> = {};
        for (const [key, entry] of Object.entries(f)) {
          if (entry.fields === undefined) continue;
          fieldsByKey[key] = entry.fields as FieldInput;
          typeByKey[key] = key.split('/')[1] as string;
          currentNsByKey[key] = 'shop';
        }
        const env = decodeEnvelope(res.body as Buffer, {
          fieldsByKey,
          typeByKey,
          schemas,
          currentNsByKey
        });
        const json = [aggJson, nestedJson][i];
        expect(env.data).toEqual(json?.data);
        expect(env.shapes).toEqual(json?.shapes);
      }

      // A nested selection reusing a declared field name is refused by the
      // validator, so the pack encoder never sees it.
      const clash = await post(
        {
          'shop/Note': {
            fields: { body: true, item: { _walk: { out: 'item' }, fields: { label: true } } }
          }
        },
        true
      );
      expect(clash.status).toBe(200);
      const refused = unpackFrame(clash.body as Buffer) as PackEnvelope;
      expect(refused.data['shop/Note']).toBeUndefined();
      expect(refused.errors?.[0]).toMatchObject({
        code: 'walk_unsupported_ref',
        path: ['shop/Note', 'fields', 'item']
      });
    } finally {
      await composed.stop();
    }
  });
});
