import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { app, seedSteps } from './_scenario.ts';
import { steps } from './warehouse/steps.ts';

type Body = Record<string, { params: { amount?: unknown; status?: string; customer?: string } }>;
const created = seedSteps
  .map((s) => (s.body as Body)['app/createInvoice']?.params)
  .filter((p): p is NonNullable<typeof p> => p !== undefined);
const sent = created.filter((p) => p.status === 'sent') as unknown as {
  amount: number;
  dueAt: string;
  customer: string;
}[];
const customers = seedSteps
  .map(
    (s) =>
      (s.body as Record<string, { params: { id?: string; name?: string } }>)['app/createCustomer']
        ?.params
  )
  .filter((p) => p !== undefined);

const sum = (rows: { amount: number }[]) => rows.reduce((a, r) => a + BigInt(r.amount), 0n);

describe('warehouse example', () => {
  it('runs, and every figure matches the seed', async () => {
    const n = normalise(await runExample({ name: 'warehouse', namespaces: [app] }, steps));
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot('./warehouse/output.json');
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }

    const [months, perCustomer] = n.steps.slice(-2).map((s) => s.response) as [
      {
        data: {
          'app/Invoice': { groups: { month: string; outstanding: string; invoices: number }[] };
        };
      },
      {
        data: {
          'app/Customer': { name: string; _agg: { open: number; nextDue: string | null } }[];
        };
      }
    ];

    const groups = months.data['app/Invoice'].groups;
    const byMonth = new Map<string, typeof sent>();
    for (const r of sent) {
      const key = `${r.dueAt.slice(0, 7)}-01T00:00:00.000000Z`;
      byMonth.set(key, [...(byMonth.get(key) ?? []), r]);
    }
    expect(groups.length).toBeGreaterThanOrEqual(3);
    for (const g of groups) expect(g.month).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000000Z$/);
    expect(groups.map((g) => g.month)).toEqual([...byMonth.keys()].sort());
    for (const g of groups) {
      const rows = byMonth.get(g.month) ?? [];
      expect(BigInt(g.outstanding), g.month).toBe(sum(rows));
      expect(g.invoices, g.month).toBe(rows.length);
    }

    const rows = perCustomer.data['app/Customer'];
    expect(rows.map((r) => r.name)).toEqual(customers.map((c) => c?.name).sort());
    for (const r of rows) {
      const id = customers.find((c) => c?.name === r.name)?.id;
      const mine = sent.filter((p) => p.customer === id);
      expect(r._agg.open, r.name).toBe(mine.length);
      const next = mine.map((p) => p.dueAt).sort()[0] as string;
      expect(r._agg.nextDue, r.name).toBe(next);
    }
  });
});
