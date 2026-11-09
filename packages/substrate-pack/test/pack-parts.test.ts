/**
 * `packEnvelopeParts` writes the bytes `encodeEnvelope` does, in pieces, and
 * `positionValue` of a slice of a list's rows is that slice of the whole.
 */

import type { PackEnvelope, Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  type EncodeEnvelopeCtx,
  encodeEnvelope,
  packEnvelopeParts,
  positionValue,
  withData
} from '../src/encoder.js';

const schema: Schema = {
  schemaVersion: 'test000000aa',
  types: {
    Todo: {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        n: { kind: 'scalar', type: 'number' },
        meta: { kind: 'scalar', type: 'json' }
      }
    }
  },
  mutations: {}
};
const ctx: EncodeEnvelopeCtx = {
  fieldsByKey: { 'ns/Todo': { id: true, title: true, n: true, meta: true } },
  typeByKey: { 'ns/Todo': 'Todo' },
  schemas: { ns: schema },
  currentNsByKey: { 'ns/Todo': 'ns' }
};

function envelope(rows: number): PackEnvelope {
  return {
    schemaVersion: 'v1',
    data: {
      'ns/Todo': Array.from({ length: rows }, (_, i) => ({
        id: `t${i}`,
        title: i % 3 === 0 ? 'é unicode' : `title ${i}`,
        n: i % 2 === 0 ? i : i + 0.5,
        meta: i % 5 === 0 ? null : { k: i, tags: ['a'] }
      })),
      'ns/count': { count: rows },
      'ns/Gone': undefined
    },
    shapes: { 'ns/Todo': 'list', 'ns/count': 'count', 'ns/Gone': 'list' },
    _pagination: { 'ns/Todo': { hasMore: false } }
  } as unknown as PackEnvelope;
}

function wireOf(env: PackEnvelope): PackEnvelope {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(env.data)) data[key] = positionValue(env, ctx, key);
  return withData(env, data);
}

describe('packEnvelopeParts', () => {
  it.each([0, 1, 15, 16, 99, 100, 101, 250, 65_535, 65_536, 70_001])(
    'concatenates to encodeEnvelope at %i rows',
    (rows) => {
      const env = envelope(rows);
      // Collect every piece before joining, so a piece that aliased a reused buffer would show.
      const parts = [...packEnvelopeParts(wireOf(env), 100)];
      expect(Buffer.concat(parts).equals(encodeEnvelope(env, ctx))).toBe(true);
    }
  );

  it('positions a list a slice at a time as it does whole', () => {
    const env = envelope(250);
    const rows = env.data['ns/Todo'] as unknown[];
    const sliced = [0, 100, 200].flatMap(
      (i) => positionValue(env, ctx, 'ns/Todo', rows.slice(i, i + 100)) as unknown[]
    );
    expect(sliced).toEqual(positionValue(env, ctx, 'ns/Todo'));
  });
});
