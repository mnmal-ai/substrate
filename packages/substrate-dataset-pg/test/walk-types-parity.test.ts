/**
 * `walkTypes` (the type tables a pg read preloads, F19) reaches exactly the
 * far types substrate-core's `walkSites` finds for the same frame. Both walk
 * substrate-filter's `forEachWalkHop`; this pins that the pg side maps a
 * read's split params (`where`, `agg`, `nested`) back onto the frame entry
 * correctly, and resolves each hop as core's validator does. A type the
 * preload missed would make a working walk read throw on every layout.
 *
 * Pure: nothing connects to a database.
 */

import { hopResolver, walkSites } from '@mnmal-ai/substrate-core';
import type { FieldDef, TypeSchema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { walkTypes } from '../src/pg-sql/walk.js';

const NS = 'ns';
const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const num: FieldDef = { kind: 'scalar', type: 'number' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const FIELDS: Record<string, Record<string, FieldDef>> = {
  Cert: { grade: num, ask: num, spec: ref('Spec') },
  Spec: { tier: num },
  Sale: { spec: ref('Spec'), at: date, price: num },
  Obs: { cert: ref('Cert'), at: date, price: num, seller: ref('Seller') },
  Seller: { rating: num },
  Note: { obs: ref('Obs'), at: date }
};
const SCHEMAS: Record<string, TypeSchema> = Object.fromEntries(
  Object.entries(FIELDS).map(([type, fields]) => [
    type,
    {
      fields,
      inboundRefs: Object.entries(FIELDS).flatMap(([t, fs]) =>
        Object.entries(fs)
          .filter(([, d]) => d.kind === 'crossRef' && d.type === type)
          .map(([field]) => ({ type: t, field }))
      )
    }
  ])
);
const fieldDef = (t: string, f: string) => FIELDS[t]?.[f];
const resolve = hopResolver(NS, (t) => SCHEMAS[t]);

const pickHub = {
  _walk: {
    out: 'spec',
    where: { _walk: { in: 'ns/Sale.spec', pick: { latest: 'at' }, where: { price: { gt: 1 } } } }
  }
};
const CORPUS: Array<{ seed: string; params: Record<string, unknown> }> = [
  { seed: 'Cert', params: { where: { grade: { eq: 1 } } } },
  {
    seed: 'Cert',
    params: {
      where: {
        OR: [{ _walk: { in: 'ns/Obs.cert' } }, { NOT: { _walk: { out: 'spec' } } }]
      }
    }
  },
  {
    seed: 'Cert',
    params: {
      where: {
        _agg: { in: 'ns/Obs.cert', where: { _walk: { out: 'seller' } }, count: true },
        gt: 1
      }
    }
  },
  { seed: 'Cert', params: { where: { AND: [{ grade: { gt: 1 } }, pickHub] } } },
  {
    seed: 'Cert',
    params: {
      nested: {
        obs: {
          _walk: { in: 'ns/Obs.cert', where: { _walk: { out: 'seller' } } },
          where: { _walk: { in: 'ns/Note.obs' } },
          fields: {
            price: true,
            notes: { _walk: { in: 'ns/Note.obs' }, fields: { at: true } },
            _agg: { n: { out: 'seller', count: true } }
          }
        }
      }
    }
  },
  {
    seed: 'Spec',
    params: {
      agg: {
        last: { in: 'ns/Sale.spec', latest: { by: 'at', value: 'price' } },
        n: { in: 'ns/Cert.spec', where: { _walk: { in: 'ns/Obs.cert' } }, count: true }
      },
      where: { _walk: { in: 'ns/Sale.spec' } }
    }
  }
];

/** The frame entry `{ params, fields }` a read's params were split from. */
function entryOf(params: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...((params.nested as object) ?? {}) } as Record<string, unknown>;
  if (params.agg !== undefined) fields._agg = params.agg;
  return { params: { where: params.where }, fields };
}

describe('walkTypes reaches what core walkSites reaches', () => {
  for (const { seed, params } of CORPUS) {
    it(JSON.stringify(params).slice(0, 90), () => {
      const core = new Set([seed, ...walkSites(entryOf(params), seed, resolve).map((s) => s.far)]);
      expect([...walkTypes(params, seed, fieldDef)].sort()).toEqual([...core].sort());
      // Every case but the plain where reaches a far type.
      if (params.where !== CORPUS[0]?.params.where) expect(core.size).toBeGreaterThan(1);
    });
  }
});
