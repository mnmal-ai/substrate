/**
 * An integer walk `_agg` reaches clients: an int64 sum past 2^53 is a decimal
 * string on the JSON wire and an exact bigint from the pack wire.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { decodeEnvelope, PACK_MIME } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { FieldInput, PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

describe('/substrate/v1/query integer walk aggregates', () => {
  it('an int64 sum is a decimal string on JSON and an exact bigint on pack', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({
      namespace: 'shop',
      walkReference: true,
      fieldDefLookup: (type, f) =>
        type === 'Payment' && f === 'amount' ? { kind: 'scalar', type: 'int64' } : undefined
    });
    await dataset.write('Customer', [{ id: 'c1', label: 'a' }]);
    await dataset.write('Payment', [
      { id: 'p1', customer: 'c1', amount: 9007199254740993n },
      { id: 'p2', customer: 'c1', amount: 1n }
    ] as never);
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      datasets: { shop: dataset },
      coordinators: [
        {
          name: 'shop',
          contractVersion: '*',
          namespaces: [
            defineNamespace('shop', {
              Customer: { fields: { label: field.string() } },
              Payment: {
                fields: {
                  customer: field.crossRef('shop', 'Customer'),
                  amount: field.int64()
                }
              }
            })
          ]
        }
      ]
    });
    await server.start();
    const frame = {
      'shop/Customer': {
        fields: {
          label: true,
          _agg: { total: { in: 'shop/Payment.customer', sum: 'amount' } }
        }
      }
    };
    const post = (pack: boolean) =>
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
      const json = JSON.parse(String((await post(false)).body)) as PackEnvelope;
      expect(json.errors).toBeUndefined();
      expect(json.data['shop/Customer']).toEqual([
        { label: 'a', _agg: { total: '9007199254740994' } }
      ]);

      const res = await post(true);
      const env = decodeEnvelope(res.body as Buffer, {
        fieldsByKey: { 'shop/Customer': frame['shop/Customer'].fields as unknown as FieldInput },
        typeByKey: { 'shop/Customer': 'Customer' },
        schemas: composed.engine.federatedSchema(),
        currentNsByKey: { 'shop/Customer': 'shop' }
      });
      // The pack wire carries the int64 natively and decodes it to a bigint.
      expect(env.data['shop/Customer']).toEqual([
        { label: 'a', _agg: { total: 9007199254740994n } }
      ]);
    } finally {
      await composed.stop();
    }
  });
});
