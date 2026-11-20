import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { owned } from './self-tending/namespace.ts';
import { steps } from './self-tending/steps.ts';

type Rec = { id: string; type: string; action: string; state: string; declarationJson: string };

describe.skipIf(!process.env.POSTGRES_URL)('self-tending example (pg)', () => {
  it('records slow reads, recommends an index, and serves the read from it once approved', async () => {
    const setup = {
      name: 'self-tending',
      namespaces: [],
      agents: ['ops-agent'],
      dataset: 'pg' as const,
      advisor: { owned, storeProfile: 'scale' as const }
    };
    const raw = await runExample(setup, steps);
    const n = normalise(raw);
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot(
      './self-tending/output.json'
    );
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }

    const [, , , recs, approved] = n.steps.map((s) => s.response) as [
      unknown,
      unknown,
      unknown,
      { data: { '_system/IndexRecommendation': Rec[] } },
      { data: { '_system_proposals/propose_index': unknown } }
    ];
    const rows = recs.data['_system/IndexRecommendation'];
    expect(rows.filter((r) => r.action === 'add')).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'Event', action: 'add', state: 'open' });
    expect(JSON.parse(rows[0]?.declarationJson as string).fields[0]).toBe('status');
    expect(approved.data['_system_proposals/propose_index']).toBeDefined();
    expect(n.steps[4]?.body).toMatchObject({
      '_system_proposals/propose_index': { params: { recommendationId: rows[0]?.id } }
    });

    // Ids as the server issued them, before normalising: the same rows in the same order, and
    // each of the three has its own createdAt, so the order cannot be a tie.
    type Read = { data: { 'ops/Event': { id: string }[] } };
    const ids = (i: number) =>
      (raw.steps[i] as { response: Read }).response.data['ops/Event'].map((r) => r.id);
    expect(ids(2)).toHaveLength(3);
    expect(ids(5)).toEqual(ids(2));

    // The plan of the statement the engine itself sent for the final read, with its bound
    // parameters. Plans are not in the transcript: their costs vary by run.
    const plan = raw.plans?.[steps[5]?.label as string];
    expect(plan, 'the final read was explained').toBeDefined();
    const sql = postgres(process.env.POSTGRES_URL as string, { onnotice: () => {} });
    try {
      const [table] = await sql<{ table_name: string }[]>`
        SELECT table_name FROM substrate_type_tables WHERE namespace = 'ops' AND type = 'Event'`;
      const [index] = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ${table?.table_name as string}
          AND indexname LIKE '%status_createdat%'`;
      expect(index, 'the approved index exists').toBeDefined();
      expect(plan).toContain(index?.indexname as string);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
