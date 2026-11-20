import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { app } from './_scenario.ts';
import { steps } from './reshape/steps.ts';

describe('reshape example', () => {
  it('proposes a type that references code, uses it at once, and records who proposed it', async () => {
    const setup = {
      name: 'reshape',
      namespaces: [app],
      agents: ['schema-agent'],
      proposals: { owned: ['billing'] }
    };
    const n = normalise(await runExample(setup, steps));
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot('./reshape/output.json');
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }
    const [proposed, , walked, record] = n.steps.slice(-4).map((s) => s.response) as [
      { data: Record<string, unknown> },
      unknown,
      {
        data: {
          'billing/Payment': { amount: string; settles: { number: string; status: string }[] }[];
        };
      },
      { data: { 'billing/TypeProposal': { applied: boolean; proposedBy: string }[] } }
    ];
    expect(proposed.data['billing/propose_type']).toBeDefined();
    const [payment] = walked.data['billing/Payment'];
    expect(walked.data['billing/Payment']).toHaveLength(1);
    expect(payment?.settles).toMatchObject([{ number: 'INV-1002', status: 'sent' }]);
    const [row] = record.data['billing/TypeProposal'];
    expect(row?.applied).toBe(true);
    expect(row?.proposedBy).toBe('schema-agent');
  });
});
