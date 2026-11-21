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
import type { TypeRef } from '@mnmal-ai/substrate-filter';
import type { FieldDef, TypeSchema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { walkTypes } from '../src/pg-sql/walk.js';

const NS = 'ns';
const ref = (type: string, ns = NS): FieldDef => ({
  kind: 'crossRef',
  ns,
  type,
  onDelete: 'set_null'
});
const num: FieldDef = { kind: 'scalar', type: 'number' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
/**
 * Fields by namespace and type. `ext`, `app` and `other` are crossed: ext's
 * Payment and Refund point at app's Invoice, which points at other's Customer,
 * and `Payment` is a type in both ext and app.
 */
const FIELDS: Record<string, Record<string, Record<string, FieldDef>>> = {
  [NS]: {
    Cert: { grade: num, ask: num, spec: ref('Spec') },
    Spec: { tier: num },
    Sale: { spec: ref('Spec'), at: date, price: num },
    Obs: { cert: ref('Cert'), at: date, price: num, seller: ref('Seller') },
    Seller: { rating: num },
    Note: { obs: ref('Obs'), at: date }
  },
  ext: {
    Payment: { invoice: ref('Invoice', 'app'), amount: num },
    Refund: { invoice: ref('Invoice', 'app'), amount: num }
  },
  app: {
    Invoice: { customer: ref('Customer', 'other'), total: num },
    Payment: { invoice: ref('Invoice', 'app'), at: date }
  },
  other: { Customer: { rating: num } }
};
const SCHEMAS: Record<string, Record<string, TypeSchema>> = Object.fromEntries(
  Object.entries(FIELDS).map(([ns, types]) => [
    ns,
    Object.fromEntries(
      Object.entries(types).map(([type, fields]) => [
        type,
        {
          fields,
          inboundRefs: Object.entries(types).flatMap(([t, fs]) =>
            Object.entries(fs)
              .filter(([, d]) => d.kind === 'crossRef' && d.ns === ns && d.type === type)
              .map(([field]) => ({ type: t, field }))
          )
        }
      ])
    )
  ])
);
const fieldDef = (t: TypeRef, f: string) => FIELDS[t.ns]?.[t.type]?.[f];
const resolverFor = (seed: TypeRef) =>
  hopResolver(seed.ns, SCHEMAS[seed.ns] ?? {}, {
    schemaOf: (ns) => SCHEMAS[ns],
    canRead: () => true,
    isStoredType: () => true,
    walkable: () => true
  });
const key = (t: TypeRef) => `${t.ns}/${t.type}`;

const pickHub = {
  _walk: {
    out: 'spec',
    where: { _walk: { in: 'ns/Sale.spec', pick: { latest: 'at' }, where: { price: { gt: 1 } } } }
  }
};
/** `reaches`, where given, is every type the frame's walks reach, seed first. */
const CORPUS: Array<{ seed: TypeRef; params: Record<string, unknown>; reaches?: string[] }> = [
  { seed: { ns: NS, type: 'Cert' }, params: { where: { grade: { eq: 1 } } } },
  {
    seed: { ns: NS, type: 'Cert' },
    params: {
      where: {
        OR: [{ _walk: { in: 'ns/Obs.cert' } }, { NOT: { _walk: { out: 'spec' } } }]
      }
    }
  },
  {
    seed: { ns: NS, type: 'Cert' },
    params: {
      where: {
        _agg: { in: 'ns/Obs.cert', where: { _walk: { out: 'seller' } }, count: true },
        gt: 1
      }
    }
  },
  { seed: { ns: NS, type: 'Cert' }, params: { where: { AND: [{ grade: { gt: 1 } }, pickHub] } } },
  {
    seed: { ns: NS, type: 'Cert' },
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
    seed: { ns: NS, type: 'Spec' },
    params: {
      agg: {
        last: { in: 'ns/Sale.spec', latest: { by: 'at', value: 'price' } },
        n: { in: 'ns/Cert.spec', where: { _walk: { in: 'ns/Obs.cert' } }, count: true }
      },
      where: { _walk: { in: 'ns/Sale.spec' } }
    }
  },
  // A double crossing: ext to app to other.
  {
    seed: { ns: 'ext', type: 'Payment' },
    params: { where: { _walk: { out: 'invoice', where: { _walk: { out: 'customer' } } } } },
    reaches: ['ext/Payment', 'app/Invoice', 'other/Customer']
  },
  // A return to the seed's namespace: ext to app to ext.
  {
    seed: { ns: 'ext', type: 'Payment' },
    params: {
      where: { _walk: { out: 'invoice', where: { _walk: { in: 'ext/Refund.invoice' } } } }
    },
    reaches: ['ext/Payment', 'app/Invoice', 'ext/Refund']
  },
  // Same-named types: app's Payment and ext's Payment are two types.
  {
    seed: { ns: 'app', type: 'Invoice' },
    params: {
      agg: { n: { in: 'app/Payment.invoice', count: true } },
      nested: { paid: { _walk: { in: 'ext/Payment.invoice' }, fields: { amount: true } } }
    },
    reaches: ['app/Invoice', 'ext/Payment', 'app/Payment']
  },
  // A walked group key: one out hop, into another namespace.
  {
    seed: { ns: 'ext', type: 'Payment' },
    params: {
      aggregate: { n: { count: true } },
      groupBy: { total: 'invoice.total', next: { add: ['invoice.total', 1] } }
    },
    reaches: ['ext/Payment', 'app/Invoice']
  }
];

/** The frame entry `{ params, fields }` a read's params were split from. */
function entryOf(params: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...((params.nested as object) ?? {}) } as Record<string, unknown>;
  if (params.agg !== undefined) fields._agg = params.agg;
  return { params: { where: params.where, groupBy: params.groupBy }, fields };
}

describe('walkTypes reaches what core walkSites reaches', () => {
  for (const { seed, params, reaches } of CORPUS) {
    it(`${key(seed)} ${JSON.stringify(params).slice(0, 90)}`, () => {
      const core = new Set([
        key(seed),
        ...walkSites(entryOf(params), seed, resolverFor(seed)).map((s) => key(s.far))
      ]);
      const types = walkTypes(params, seed, fieldDef);
      expect(types.map(key).sort()).toEqual([...core].sort());
      if (reaches !== undefined) expect(types.map(key)).toEqual(reaches);
      // Every case but the plain where reaches a far type.
      if (params.where !== CORPUS[0]?.params.where) expect(core.size).toBeGreaterThan(1);
    });
  }
});
