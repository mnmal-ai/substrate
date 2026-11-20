import { describe, expect, it } from 'vitest';
import type { StepResult, Transcript } from '../examples/_harness.ts';
import { loadExample } from '../src/lib/examples.ts';
import { feedEvents } from '../src/lib/feed.ts';

const step = (s: Partial<StepResult>): StepResult => ({
  label: 'a step',
  method: 'POST',
  path: '/substrate/v1/query',
  feed: false,
  status: 200,
  response: {},
  ...s
});

const live: Transcript = {
  example: 'live',
  steps: [
    step({
      path: '/substrate/v1/subscribe',
      stream: 'open',
      body: { 'app/Task': { params: { where: { status: { eq: 'open' } } }, fields: { id: true } } },
      response: { kind: 'snapshot', data: { 'app/Task': [] } }
    }),
    step({
      path: '/substrate/v1/mutate',
      feed: true,
      as: 'billing-agent',
      body: {
        'app/createTask': {
          params: {
            id: '0197a000-0000-7000-8000-000000000001',
            title: `Chase ${'a very long customer name '.repeat(6)}for INV-1002`,
            status: 'open'
          },
          fields: { id: true }
        }
      },
      response: { data: { 'app/createTask': { id: '0197a000-0000-7000-8000-000000000001' } } }
    }),
    step({
      path: '/substrate/v1/subscribe',
      feed: true,
      receive: 'open',
      response: {
        kind: 'add',
        data: { 'app/Task': { id: '0197a000-0000-7000-8000-000000000001' } }
      }
    })
  ]
};

const warehouse: Transcript = {
  example: 'warehouse',
  steps: [
    step({ body: { 'app/Customer': { params: {}, fields: { name: true } } } }),
    step({
      feed: true,
      body: {
        'app/Invoice': {
          params: {
            where: { status: { eq: 'sent' } },
            aggregate: { outstanding: { sum: 'amount' }, invoices: { count: true } },
            groupBy: { month: { dateTrunc: [{ lit: 'month' }, 'dueAt'] } },
            orderBy: [{ month: 'asc' }]
          },
          fields: { id: true }
        }
      },
      response: { data: { 'app/Invoice': { groups: [{}, {}, {}, {}] } } }
    })
  ]
};

describe('feedEvents', () => {
  it('derives every event from a transcript step', () => {
    const events = feedEvents([live, warehouse]);
    expect(events).toHaveLength(3);
    // The receive step has no body: its frame key is the one its stream subscribed to.
    for (const [i, key] of ['app/createTask', 'app/Task', 'app/Invoice'].entries()) {
      expect(events[i]?.kind).toContain(key);
    }
  });

  it('keeps lines short', () => {
    const real = ['onboard', 'coordinate', 'warehouse'].map((n) => loadExample(n).transcript);
    const events = feedEvents([live, warehouse, ...real.filter((t) => t !== null)]);
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) expect(e.line.length, e.line).toBeLessThanOrEqual(80);
  });

  it('reads the coordinate example as a write, its live arrival, and the claim', () => {
    const t = loadExample('coordinate').transcript;
    expect(t).not.toBeNull();
    expect(feedEvents(t === null ? [] : [t])).toEqual([
      {
        kind: 'mutate · app/createTask',
        line: 'title: "Chase Lumen Works for INV-1002", status: "open"',
        result: '→ created, signed by billing-agent'
      },
      { kind: 'subscribe · app/Task', line: 'where status eq open', result: '→ +1 row, live' },
      {
        kind: 'mutate · app/updateTask',
        line: 'status: "in_progress"',
        result: '→ updated, signed by collections-agent'
      }
    ]);
  });
});

describe('loadExample', () => {
  it("returns an example's own files by name, and nothing for an unknown one", () => {
    const { files } = loadExample('coordinate');
    expect(Object.keys(files).sort()).toEqual(['namespace.ts', 'steps.ts']);
    expect(files['steps.ts']).toContain('export const steps');
    expect(loadExample('no-such-example')).toEqual({ files: {}, transcript: null });
  });
});
