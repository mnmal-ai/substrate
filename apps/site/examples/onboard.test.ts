import { describe, expect, it } from 'vitest';
import { normalise, runExample, type StepResult } from './_harness.ts';
import { app } from './onboard/namespace.ts';
import { EVERY_SURFACE, steps } from './onboard/steps.ts';

type Rows = {
  data: { 'app/Invoice': { number: string; dueAt: string; billedTo: { name: string }[] }[] };
};

type Grammar = { queryKey: string; mutationKey: string };

describe('onboard example', () => {
  it('runs, and its transcript is the page', async () => {
    const t = await runExample({ name: 'onboard', namespaces: [app] }, steps);
    // Trim the two self-description responses to what the page shows. A moved key throws.
    const [onboard, schema] = t.steps.slice(-2) as [StepResult, StepResult];
    const ob = onboard.response as { binary: { coordinators: unknown }; frameGrammar: Grammar };
    onboard.response = {
      binary: { coordinators: ob.binary.coordinators },
      frameGrammar: { queryKey: ob.frameGrammar.queryKey, mutationKey: ob.frameGrammar.mutationKey }
    };
    const sc = schema.response as { types: object; mutations: object };
    schema.response = { types: sc.types, mutations: Object.keys(sc.mutations) };
    const n = normalise(t);
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot('./onboard/output.json');

    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }
    const step = (label: string) => {
      const found = n.steps.find((s) => s.label === label);
      expect(found, label).toBeDefined();
      return found as StepResult;
    };
    const rows = (step('Query sent invoices, with the customer').response as Rows).data[
      'app/Invoice'
    ];
    expect(rows.length).toBe(6);
    expect(rows.map((r) => r.number)).toEqual([
      'INV-1002',
      'INV-1003',
      'INV-1005',
      'INV-1006',
      'INV-1007',
      'INV-1009'
    ]);
    const due = rows.map((r) => r.dueAt);
    expect(due).toEqual([...due].sort());
    for (const r of rows) expect(r.billedTo[0]?.name).toBeTruthy();

    // The walk-free read returns the same invoices in the same order, with only its two fields.
    const plain = step(EVERY_SURFACE).response as { data: { 'app/Invoice': object[] } };
    const plainRows = plain.data['app/Invoice'];
    expect(plainRows).toEqual(rows.map((r) => ({ number: r.number, dueAt: r.dueAt })));
    expect(Object.keys(sc.mutations)).toContain('createInvoice');
  });
});
