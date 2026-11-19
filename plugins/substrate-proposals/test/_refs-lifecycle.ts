/**
 * The write, filter and delete lifecycle of a proposed type that references a
 * code-defined type, shared by the memory and pg suites.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type { PackEnvelope, RequestContext } from '@mnmal-ai/substrate-types';
import { expect } from 'vitest';

type Ctx = Partial<RequestContext>;

/** Runs one frame and returns its payload, failing on any error. */
async function run(
  engine: Engine,
  kind: 'query' | 'mutate',
  key: string,
  frame: { params?: Record<string, unknown>; fields: Record<string, unknown> },
  ctx: Ctx
): Promise<unknown> {
  const env: PackEnvelope = await engine[kind]({ frame: { [key]: frame }, ctx });
  expect(env.errors).toBeUndefined();
  return env.data[key];
}

/**
 * `ext` proposes `Payment` (set_null) and `Receipt` (cascade), both referencing
 * `app/Invoice`; once the sweep runs, a deleted invoice has nulled the one and
 * removed the other.
 */
export async function referenceLifecycle(
  engine: Engine,
  ext: string,
  app: string,
  ctx: Ctx,
  sweep: () => Promise<unknown>
): Promise<void> {
  const ref = (onDelete?: string) => ({ kind: 'crossRef', ns: app, type: 'Invoice', onDelete });
  for (const [typeName, onDelete] of [
    ['Payment', undefined],
    ['Receipt', 'cascade']
  ] as const) {
    await run(
      engine,
      'mutate',
      `${ext}/propose_type`,
      { params: { typeName, fields: { invoice: ref(onDelete) } }, fields: { id: true } },
      ctx
    );
  }
  const create = async (key: string, params: Record<string, unknown>): Promise<string> =>
    ((await run(engine, 'mutate', key, { params, fields: { id: true } }, ctx)) as { id: string })
      .id;
  const kept = await create(`${app}/createInvoice`, { number: 'kept' });
  const cascaded = await create(`${app}/createInvoice`, { number: 'cascaded' });
  const payment = await create(`${ext}/createPayment`, { invoice: kept });
  await create(`${ext}/createReceipt`, { invoice: cascaded });

  const rows = async (type: string, invoice: string | null) =>
    (await run(
      engine,
      'query',
      `${ext}/${type}`,
      { params: { where: { invoice: { eq: invoice } } }, fields: { id: true } },
      ctx
    )) as Array<{ id: string }>;
  expect((await rows('Payment', kept)).map((r) => r.id)).toEqual([payment]);
  expect(await rows('Payment', cascaded)).toEqual([]);

  const del = (invoice: string) =>
    run(engine, 'mutate', `${app}/deleteInvoice`, { params: { id: invoice }, fields: {} }, ctx);
  // Delete policies apply when the sweep next runs.
  await del(kept);
  await sweep();
  expect(await rows('Payment', kept)).toEqual([]);
  expect((await rows('Payment', null)).map((r) => r.id)).toEqual([payment]);

  expect(await rows('Receipt', cascaded)).toHaveLength(1);
  await del(cascaded);
  await sweep();
  expect(await rows('Receipt', cascaded)).toEqual([]);
  expect(await rows('Receipt', null)).toEqual([]);
}
