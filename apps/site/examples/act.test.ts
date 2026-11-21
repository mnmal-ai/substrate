import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { app } from './act/namespace.ts';
import { PAY, steps } from './act/steps.ts';

type By = { kind: string; id: string };
type Reply = {
  ok: boolean;
  ack?: string;
  result?: string;
  help?: { type?: string; actions?: Record<string, unknown> };
  refusal?: { code: string; token: string; nearest?: string };
};
type Row = { status: string; _metadata: { updatedBy?: By } };

describe('act example', () => {
  it('runs: a sketch pays an invoice and closes its task in one transaction', async () => {
    const t = await runExample(
      { name: 'act', namespaces: [app], agents: ['collections-agent'] },
      steps
    );
    // Result ids are random; number them in step order so the page is stable.
    let n = 0;
    for (const s of t.steps) {
      const r = s.response as Reply;
      if (typeof r.result === 'string') r.result = `r_${++n}`;
    }
    const out = normalise(t);
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot('./act/output.json');
    for (const s of out.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }

    const [created, help, paid, typo, read] = out.steps.slice(-5).map((s) => s.response) as [
      Reply,
      Reply,
      Reply,
      Reply,
      { data: { 'app/Invoice': Row[]; 'app/Task': Row[] } }
    ];
    expect(created).toMatchObject({ ok: true, ack: 'created app/Task #1' });
    expect(help.help?.type).toBe('app/Invoice');
    expect(Object.keys(help.help?.actions ?? {})).toEqual(expect.arrayContaining(['pay', 'void']));
    expect(out.steps.find((s) => s.label === PAY)?.response).toBe(paid);
    expect(paid).toMatchObject({ ok: true, ack: 'paid app/Invoice #2; closed app/Task #1' });
    expect(typo).toMatchObject({
      ok: false,
      refusal: { code: 'sketch_unresolved', token: 'Invoce', nearest: 'pay Invoice #3' }
    });
    expect(typo).not.toHaveProperty('result');

    const agent = { kind: 'agent', id: 'collections-agent' };
    expect(read.data['app/Invoice']).toEqual([
      expect.objectContaining({ status: 'paid', _metadata: { updatedBy: agent } })
    ]);
    expect(read.data['app/Task']).toEqual([
      expect.objectContaining({ status: 'done', _metadata: { updatedBy: agent } })
    ]);
  });
});
