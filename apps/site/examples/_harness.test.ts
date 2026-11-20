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

  it('pins every schemaVersion, at any depth', () => {
    const t: Transcript = {
      example: 'x',
      steps: [
        {
          label: 'a',
          method: 'GET',
          path: '/p',
          feed: false,
          status: 200,
          response: { schemaVersion: '9a75ac1bfcbb', data: [{ meta: { schemaVersion: 'f18c' } }] }
        }
      ]
    };
    expect(normalise(t).steps[0]?.response).toEqual({
      schemaVersion: 'schema',
      data: [{ meta: { schemaVersion: 'schema' } }]
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
          // Ordered on a field: two rows written in one millisecond tie on the natural order.
          body: {
            'app/Invoice': {
              params: { limit: 1, orderBy: [{ number: 'asc' }] },
              fields: { id: true, number: true }
            }
          }
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

  it('throws on ask with agents: nothing would check the signature', async () => {
    await expect(runExample({ ...setup, ask: {}, agents: ['a'] }, [])).rejects.toThrow(
      /ask runs unsigned/
    );
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
    type By = { kind: string; id: string };
    type Created = { data: Record<string, { _metadata: { createdBy: By } }> };
    const by = (i: number) =>
      (t.steps[i] as { response: Created }).response.data['app/createCustomer']?._metadata
        .createdBy;
    expect(t.steps.map((s) => s.status)).toEqual([200, 200]);
    // An agent key writes as an agent; the system key keeps the default kind.
    expect([by(0), by(1)]).toEqual([
      { kind: 'user', id: SYSTEM_KID },
      { kind: 'agent', id: 'billing-agent' }
    ]);
  });

  it('holds a stream open across steps and records its frames in order', async () => {
    const cid = '0197a111-1111-7111-8111-111111111111';
    const mutate = (label: string, body: unknown): Step => ({
      label,
      method: 'POST',
      path: '/substrate/v1/mutate',
      body
    });
    const receive: Step = {
      label: 'receive',
      method: 'POST',
      path: '/substrate/v1/subscribe',
      receive: 'customers'
    };
    const run = () =>
      runExample(setup, [
        {
          label: 'subscribe',
          method: 'POST',
          path: '/substrate/v1/subscribe',
          body: { 'app/Customer': { fields: { id: true, name: true, _metadata: true } } },
          stream: 'customers'
        },
        mutate('create', {
          'app/createCustomer': { params: { id: cid, name: 'Ada' }, fields: { id: true } }
        }),
        receive,
        // No client id, so the raw transcripts differ between runs.
        mutate('create', {
          'app/createCustomer': { params: { name: 'Bo' }, fields: { id: true } }
        }),
        receive,
        mutate('update', {
          'app/updateCustomer': { params: { id: cid, name: 'Ada L' }, fields: { id: true } }
        }),
        receive
      ]);
    const a = await run();
    const b = await run();
    type Frame = { kind: string; data?: Record<string, { name: string }> };
    const frames = a.steps
      .filter((s) => s.path.endsWith('/subscribe'))
      .map((s) => s.response as Frame);
    expect(a.steps.map((s) => s.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(a.steps[0]?.stream).toBe('customers');
    expect(a.steps[2]?.receive).toBe('customers');
    expect(a.steps[1]).not.toHaveProperty('stream');
    expect(a.steps[1]).not.toHaveProperty('receive');
    expect(frames.map((f) => [f.kind, f.data?.['app/Customer']?.name])).toEqual([
      ['snapshot', undefined],
      ['add', 'Ada'],
      ['add', 'Bo'],
      ['update', 'Ada L']
    ]);
    expect(JSON.stringify(a)).not.toContain('"errors"');
    expect(a).not.toEqual(b);
    expect(normalise(a)).toEqual(normalise(b));
  });

  it('throws when a receive has no open stream or no frame', async () => {
    const step = (label: string, extra: Partial<Step>): Step => ({
      label,
      method: 'POST',
      path: '/substrate/v1/subscribe',
      ...extra
    });
    await expect(runExample(setup, [step('r', { receive: 'nope' })])).rejects.toThrow(
      /'r' receives from 'nope', which no earlier step opened/
    );
    const open = step('open', {
      body: { 'app/Customer': { fields: { id: true } } },
      stream: 'quiet'
    });
    await expect(runExample(setup, [open, step('wait', { receive: 'quiet' })])).rejects.toThrow(
      /'wait' got no frame on 'quiet'/
    );
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
