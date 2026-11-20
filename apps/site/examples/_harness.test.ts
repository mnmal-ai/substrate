import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import {
  type ExampleSetup,
  normalise,
  runExample,
  type Step,
  SYSTEM_KID,
  type Transcript
} from './_harness.ts';

const app = defineNamespace('app', {
  Customer: { fields: { name: field.string() } },
  Invoice: {
    fields: {
      number: field.string(),
      dueAt: field.date(),
      customer: field.crossRef('app', 'Customer')
    }
  }
});
const setup: ExampleSetup = { name: 'harness', namespaces: [app] };
const ID = '0197a000-0000-7000-8000-000000000001';

describe('normalise', () => {
  it('maps ids by first appearance and keeps references consistent', () => {
    const real = '01990000-aaaa-7bbb-8ccc-123456789abc';
    const t: Transcript = {
      example: 'x',
      steps: [
        {
          label: 'a',
          method: 'POST',
          path: '/p',
          feed: false,
          status: 200,
          response: { id: real }
        },
        {
          label: 'b',
          method: 'POST',
          path: '/p',
          feed: false,
          status: 200,
          body: { id: real },
          response: {}
        }
      ]
    };
    const n = normalise(t);
    expect(n.steps[0]?.response).toEqual({ id: ID });
    expect(n.steps[1]?.body).toEqual({ id: ID });
  });

  it('pins server timestamps only', () => {
    const t: Transcript = {
      example: 'x',
      steps: [
        {
          label: 'a',
          method: 'GET',
          path: '/p',
          feed: false,
          status: 200,
          response: { createdAt: '2025-01-01T00:00:00.000Z', dueAt: '2026-10-31' }
        }
      ]
    };
    expect(normalise(t).steps[0]?.response).toEqual({
      createdAt: '2026-11-03T09:00:00.000Z',
      dueAt: '2026-10-31'
    });
  });
});

describe('normalise embedded values', () => {
  const step = (response: unknown): Transcript => ({
    example: 'x',
    steps: [{ label: 'a', method: 'GET', path: '/p', feed: false, status: 200, response }]
  });
  it('maps cursors by first appearance and ids inside longer strings', () => {
    const id = '01990000-aaaa-7bbb-8ccc-123456789abc';
    const out = normalise(
      step({
        a: { nextCursor: 'abc' },
        b: { nextCursor: 'def' },
        c: { nextCursor: 'abc' },
        d: { nextCursor: null },
        e: `no row ${id} here`,
        f: id
      })
    ).steps[0]?.response;
    expect(out).toEqual({
      a: { nextCursor: 'cursor-1' },
      b: { nextCursor: 'cursor-2' },
      c: { nextCursor: 'cursor-1' },
      d: { nextCursor: null },
      e: `no row ${ID} here`,
      f: ID
    });
  });
});

describe('runExample', () => {
  it('is stable across two runs', async () => {
    const cid = '0197a111-1111-7111-8111-111111111111';
    const mutate = (body: unknown): Step => ({
      label: 'write',
      method: 'POST',
      path: '/substrate/v1/mutate',
      body
    });
    const invoice = (n: string) =>
      mutate({
        'app/createInvoice': {
          params: { number: n, dueAt: '2026-10-31T00:00:00Z', customer: cid },
          fields: { id: true }
        }
      });
    const run = () =>
      runExample(setup, [
        mutate({
          'app/createCustomer': { params: { id: cid, name: 'Ada' }, fields: { id: true } }
        }),
        invoice('INV-1'),
        invoice('INV-2'),
        {
          label: 'page',
          method: 'POST',
          path: '/substrate/v1/query',
          body: { 'app/Invoice': { params: { limit: 1 }, fields: { id: true, number: true } } }
        }
      ]);
    const a = await run();
    const b = await run();
    expect(a.steps.map((s) => s.status)).toEqual([200, 200, 200, 200]);
    expect(JSON.stringify(a)).not.toContain('"errors"');
    expect(JSON.stringify(a)).toContain('nextCursor');
    expect(a).not.toEqual(b);
    expect(normalise(a)).toEqual(normalise(b));
  });

  it('throws on bad `as` or agents', async () => {
    const step = (as: string): Step => ({ label: 's', method: 'GET', path: '/health', as });
    await expect(runExample(setup, [step('x')])).rejects.toThrow(/no agents/);
    await expect(runExample({ ...setup, agents: ['a'] }, [step('x')])).rejects.toThrow(
      /not in agents/
    );
    await expect(runExample({ ...setup, agents: [SYSTEM_KID] }, [])).rejects.toThrow(/reserved/);
  });

  it('runs a step without `as` as the system actor when auth is on', async () => {
    const create = (as?: string): Step => ({
      label: 'create customer',
      method: 'POST',
      path: '/substrate/v1/mutate',
      ...(as === undefined ? {} : { as }),
      body: {
        'app/createCustomer': { params: { name: 'Ada' }, fields: { id: true, _metadata: true } }
      }
    });
    const t = await runExample({ ...setup, agents: ['billing-agent'] }, [
      create(),
      create('billing-agent')
    ]);
    type Created = { data: Record<string, { _metadata: { createdBy: { id: string } } }> };
    const by = (i: number) =>
      (t.steps[i] as { response: Created }).response.data['app/createCustomer']?._metadata.createdBy
        .id;
    expect(t.steps.map((s) => s.status)).toEqual([200, 200]);
    expect([by(0), by(1)]).toEqual([SYSTEM_KID, 'billing-agent']);
  });

  it('refuses a pg example without POSTGRES_URL', async () => {
    const saved = process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL;
    try {
      await expect(runExample({ ...setup, dataset: 'pg' }, [])).rejects.toThrow(/POSTGRES_URL/);
    } finally {
      if (saved !== undefined) process.env.POSTGRES_URL = saved;
    }
  });
});
