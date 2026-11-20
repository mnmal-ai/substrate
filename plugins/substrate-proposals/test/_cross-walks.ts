/**
 * Walks across the reference of a proposed type to a code-defined type, shared
 * by the memory and pg suites: a caller who can read both namespaces gets
 * correct rows, one who can read only `ext` gets the uniform denial.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type { PackEnvelope, RequestContext } from '@mnmal-ai/substrate-types';
import { expect } from 'vitest';

type Ctx = Partial<RequestContext>;

type Row = Record<string, unknown>;

/** `ext/Payment` proposed over `app/Invoice`; invoices A (two payments), B (one) and C (none). */
export async function crossWalks(
  engine: Engine,
  ext: string,
  app: string,
  admin: Ctx,
  both: Ctx,
  extOnly: Ctx,
  T = 'Payment'
): Promise<void> {
  const send = async (kind: 'query' | 'mutate', key: string, frame: unknown, ctx: Ctx) =>
    engine[kind]({ frame: { [key]: frame } as never, ctx });
  const ok = async (kind: 'query' | 'mutate', key: string, frame: unknown, ctx: Ctx) => {
    const env = await send(kind, key, frame, ctx);
    expect(env.errors, key).toBeUndefined();
    return env.data[key];
  };
  await ok(
    'mutate',
    `${ext}/propose_type`,
    {
      params: {
        typeName: T,
        fields: {
          amount: { kind: 'scalar', type: 'number' },
          invoice: { kind: 'crossRef', ns: app, type: 'Invoice' }
        }
      },
      fields: { id: true }
    },
    admin
  );
  const invoice = async (number: string): Promise<string> =>
    (
      (await ok(
        'mutate',
        `${app}/createInvoice`,
        { params: { number }, fields: { id: true } },
        admin
      )) as {
        id: string;
      }
    ).id;
  const [a, b] = [await invoice('INV-A'), await invoice('INV-B')];
  await invoice('INV-C');
  for (const [inv, amount] of [
    [a, 5],
    [a, 7],
    [b, 3]
  ] as const) {
    await ok(
      'mutate',
      `${ext}/create${T}`,
      { params: { amount, invoice: inv }, fields: { id: true } },
      admin
    );
  }

  const payments = {
    key: `${ext}/${T}`,
    frame: {
      fields: { amount: true, inv: { _walk: { out: 'invoice' }, fields: { number: true } } }
    }
  };
  const unpaid = {
    key: `${app}/Invoice`,
    frame: {
      params: { where: { _walk: { in: `${ext}/${T}.invoice`, quantifier: 'none' } } },
      fields: { number: true }
    }
  };
  const totals = {
    key: `${app}/Invoice`,
    frame: {
      params: { orderBy: [{ number: 'asc' }] },
      fields: { number: true, _agg: { paid: { in: `${ext}/${T}.invoice`, sum: 'amount' } } }
    }
  };

  const paid = (await ok('query', payments.key, payments.frame, both)) as Row[];
  expect(
    paid
      .map((r) => [r.amount, (r.inv as Row[])[0]?.number])
      .sort((x, y) => (x[0] as number) - (y[0] as number))
  ).toEqual([
    [3, 'INV-B'],
    [5, 'INV-A'],
    [7, 'INV-A']
  ]);
  expect(await ok('query', unpaid.key, unpaid.frame, both)).toEqual([
    expect.objectContaining({ number: 'INV-C' })
  ]);
  expect(
    ((await ok('query', totals.key, totals.frame, both)) as Row[]).map((r) => [
      r.number,
      (r._agg as Row).paid
    ])
  ).toEqual([
    ['INV-A', 12],
    ['INV-B', 3],
    ['INV-C', null]
  ]);

  // The `ext`-only caller reads `ext/Payment` and the far hop is `app`; the denial is the same
  // whole error for each form, whatever the far side holds.
  const denied = (path: Array<string | number>) => ({
    code: 'policy_denied',
    message: 'this walk is not permitted',
    path
  });
  const hops: Array<[unknown, Array<string | number>]> = [
    [payments.frame, [payments.key, 'fields', 'inv', '_walk']],
    [
      { params: { where: { _walk: { out: 'invoice', quantifier: 'none' } } } },
      [payments.key, 'where', '_walk']
    ],
    [
      { fields: { _agg: { n: { out: 'invoice', count: true } } } },
      [payments.key, 'fields', '_agg', 'n']
    ]
  ];
  for (const [frame, path] of hops) {
    const env: PackEnvelope = await send('query', payments.key, frame, extOnly);
    expect(env.errors, JSON.stringify(path)).toEqual([denied(path)]);
    expect(env.data[payments.key]).toBeUndefined();
  }
  // The same denial from the far side, where `app` is the seed: `app`-only callers cannot read `ext`.
  const appOnly = { ...both, identity: { ...both.identity, grants: { [app]: ['read'] } } } as Ctx;
  for (const f of [unpaid, totals]) {
    const env = await send('query', f.key, f.frame, appOnly);
    expect(env.errors?.[0], f.key).toMatchObject({
      code: 'policy_denied',
      message: 'this walk is not permitted'
    });
    expect(Object.keys(env.errors?.[0] ?? {}).sort(), f.key).toEqual(['code', 'message', 'path']);
    expect(env.data[f.key], f.key).toBeUndefined();
  }
}
