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
      advisor: { owned, storeProfile: 'scale' as const, slowReadMs: 60 }
    };
    const n = normalise(await runExample(setup, steps));
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot(
      './self-tending/output.json'
    );
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }

    const [, , recs, approved] = n.steps.map((s) => s.response) as [
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
    expect(n.steps[3]?.body).toMatchObject({
      '_system_proposals/propose_index': { params: { recommendationId: rows[0]?.id } }
    });

    // The read's plan. The advisor's rows are in the transcript; a plan is not, because its
    // costs vary by run.
    const sql = postgres(process.env.POSTGRES_URL as string, { onnotice: () => {} });
    try {
      const [table] = await sql<{ table_name: string }[]>`
        SELECT table_name FROM substrate_type_tables WHERE namespace = 'ops' AND type = 'Event'`;
      const [index] = await sql<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ${table?.table_name as string}
          AND indexname LIKE '%status_createdat%'`;
      expect(index, 'the approved index exists').toBeDefined();
      const [, status, created] = /\((\w+), (\w+)/.exec(index?.indexdef ?? '') as RegExpExecArray;
      const plan = await sql.unsafe(
        `EXPLAIN SELECT id FROM "${table?.table_name}" WHERE ${status} = 'open' AND deleted_at IS NULL ORDER BY ${created} DESC NULLS LAST LIMIT 5`
      );
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(index?.indexname as string);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
