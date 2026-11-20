import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { app, seedSteps } from './_scenario.ts';
import { steps } from './ask/steps.ts';

type Body = Record<string, { params: { status?: string; dueAt?: string } }>;
const sent = seedSteps
  .map((s) => (s.body as Body)['app/createInvoice']?.params)
  .filter((p) => p?.status === 'sent') as { dueAt: string }[];

describe('ask example', () => {
  it('reads one question into a frame and rows, and answers unknown to the other', async () => {
    // The deployment tells ask an invoice's time is its due date.
    const setup = {
      name: 'ask',
      namespaces: [app],
      ask: { rulings: { app: { timeField: { Invoice: 'dueAt' } } } }
    };
    const n = normalise(await runExample(setup, steps));
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot('./ask/output.json');
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }
    const [counted, unread] = n.steps.slice(-2).map((s) => s.response) as {
      outcome: {
        kind: string;
        source?: string;
        frame?: { 'app/Invoice': { params: Record<string, unknown> } };
        data?: { groups: { bucket: string; value: number }[] };
        plan?: unknown[];
      };
    }[];

    expect(counted?.outcome.kind).toBe('rows');
    expect(counted?.outcome.source).toBe('parser');
    const params = counted?.outcome.frame?.['app/Invoice'].params;
    expect(params?.where).toEqual({ status: { eq: 'sent' } });
    expect(params?.groupBy).toEqual({ bucket: { dateTrunc: [{ lit: 'month' }, 'dueAt'] } });

    const byMonth = new Map<string, number>();
    for (const r of sent) {
      const key = `${r.dueAt.slice(0, 7)}-01T00:00:00.000000Z`;
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    const groups = counted?.outcome.data?.groups ?? [];
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(groups.map((g) => [g.bucket, g.value])).toEqual(
      [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
    );

    expect(unread?.outcome.kind).toBe('unknown');
    expect(unread?.outcome.frame).toBeUndefined();
    expect(unread?.outcome.data).toBeUndefined();
    expect(unread?.outcome.plan).toEqual([]);
  });
});
