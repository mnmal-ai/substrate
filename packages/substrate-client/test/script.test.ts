import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SubstrateClient } from '../src/client.js';
import { runScript, type ScriptContext } from '../src/script.js';

type Handler = (frame: Record<string, unknown>) => Partial<PackEnvelope>;

function fakeClient(query: Handler, mutate: Handler = () => ({ data: {} })) {
  const calls = { query: 0, mutate: 0 };
  const wrap = (h: Handler, k: 'query' | 'mutate') => async (frame: Record<string, unknown>) => {
    calls[k]++;
    // A realistic delay, so the report's ms comes from the clock rather than the fake.
    await new Promise((r) => setTimeout(r, 5));
    return { schemaVersion: 'v', shapes: {}, data: {}, ...h(frame) } as PackEnvelope;
  };
  return {
    client: {
      query: wrap(query, 'query'),
      mutate: wrap(mutate, 'mutate')
    } as unknown as SubstrateClient,
    calls
  };
}

const create = (n: number) => ({ 'ns/createT': Array.from({ length: n }, () => ({ params: {} })) });
const run = (
  script: (s: ScriptContext) => unknown,
  client: SubstrateClient,
  mode?: 'read' | 'dry-run' | 'write',
  maxWrites?: number
) =>
  runScript(script, {
    client,
    kid: 'a@h',
    log: () => {},
    ...(mode ? { mode } : {}),
    ...(maxWrites !== undefined ? { maxWrites } : {})
  });

describe('runScript', () => {
  it('returns the script result with stats from the clock', async () => {
    const { client } = fakeClient(() => ({ data: { 'ns/T': [{ id: '1' }] } }));
    const r = await run(async (s) => (await s.query({ 'ns/T': {} })).data['ns/T'], client);
    expect(r).toMatchObject({
      ok: true,
      kid: 'a@h',
      mode: 'read',
      result: [{ id: '1' }],
      mutations: []
    });
    expect(r.stats.queries).toBe(1);
    expect(r.stats.ms).toBeGreaterThanOrEqual(4);
  });

  it('fails a query whose key is missing from data, naming the server error', async () => {
    const { client } = fakeClient(() => ({
      data: {},
      errors: [{ code: 'unknown_operator', message: 'nope' }]
    }));
    const r = await run((s) => s.query({ 'ns/T': {} }), client);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('query refused for ns/T (unknown_operator: nope)');
  });

  it('warns on a truncated query and pages queryAll to the end', async () => {
    const { client, calls } = fakeClient((frame) => {
      const cursor = (frame['ns/T'] as { params?: { cursor?: string } }).params?.cursor;
      return cursor === undefined
        ? {
            data: { 'ns/T': [{ id: '1' }] },
            _pagination: { 'ns/T': { hasMore: true, nextCursor: 'c1' } }
          }
        : { data: { 'ns/T': [{ id: '2' }] }, _pagination: { 'ns/T': { hasMore: false } } };
    });
    const r = await run(async (s) => {
      await s.query({ 'ns/T': {} });
      return s.queryAll('ns/T', { params: { limit: 1 } });
    }, client);
    expect(r.result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(r.warnings).toEqual([
      'ns/T: result truncated (hasMore); use queryAll for a complete read'
    ]);
    expect(calls.query).toBe(3);
  });

  it('query and mutate also take (key, entry), the form queryAll takes', async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = fakeClient(
      (f) => {
        seen.push(f);
        return { data: { 'ns/T': [{ id: '1' }] } };
      },
      (f) => {
        seen.push(f);
        return { data: { 'ns/createT': [{ id: 'a' }, { id: 'b' }] } };
      }
    );
    const r = await run(
      async (s) => {
        await s.query('ns/T', { params: { limit: 1 }, fields: { id: true } });
        await s.mutate('ns/createT', [{ params: {} }, { params: {} }]);
      },
      client,
      'write'
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([
      { 'ns/T': { params: { limit: 1 }, fields: { id: true } } },
      { 'ns/createT': [{ params: {} }, { params: {} }] }
    ]);
    expect(r.stats.writes).toBe(2);
  });

  it('a call that is neither form names both, without reaching the server', async () => {
    const { client, calls } = fakeClient(() => ({}));
    const r = await run((s) => s.query(42 as unknown as string, {}), client);
    expect(r.error).toBe(
      "s.query takes a frame { 'ns/Type': { params, fields } } or (key, { params, fields }), got number"
    );
    const bad = await run((s) => s.query('ns/T', 'x' as never), client);
    expect(bad.error).toBe(
      "s.query('ns/T', entry): entry must be { params?, fields? }, got string"
    );
    expect(calls.query).toBe(0);
  });

  it('refuses mutations in read mode and records them unsent in dry-run', async () => {
    const { client, calls } = fakeClient(() => ({}));
    const read = await run((s) => s.mutate(create(1)), client);
    expect(read.error).toMatch(/read mode/);
    const dry = await run((s) => s.mutate(create(2)), client, 'dry-run');
    expect(dry).toMatchObject({ ok: true, result: null, mutations: [{ applied: false }] });
    expect(calls.mutate).toBe(0);
  });

  it('caps writes by frame count and keeps the applied ones in a failed report', async () => {
    const { client, calls } = fakeClient(
      () => ({}),
      () => ({ data: { 'ns/createT': [{}] } })
    );
    const r = await run(
      async (s) => {
        await s.mutate(create(2));
        await s.mutate(create(2));
      },
      client,
      'write',
      3
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/4 frames would exceed --max-writes 3/);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]?.applied).toBe(true);
    expect(r.stats.writes).toBe(2);
    expect(calls.mutate).toBe(1);
  });

  it('caps writes sent at once, not only writes sent one after another', async () => {
    const { client, calls } = fakeClient(
      () => ({}),
      () => ({ data: { 'ns/createT': [{}] } })
    );
    const r = await run(
      (s) => Promise.all(Array.from({ length: 10 }, () => s.mutate(create(1)))),
      client,
      'write',
      3
    );
    expect(r.ok).toBe(false);
    expect(calls.mutate).toBe(3);
    expect(r.stats.writes).toBe(3);
    expect(r.mutations.filter((m) => m.applied)).toHaveLength(3);
  });

  it('frees the cap for a payload the server refused whole', async () => {
    let n = 0;
    const { client, calls } = fakeClient(
      () => ({}),
      () =>
        n++ === 0
          ? { data: {}, errors: [{ code: 'x', message: 'no' }] }
          : { data: { 'ns/createT': [{}] } }
    );
    const r = await run(
      async (s) => {
        await s.mutate(create(2)).catch(() => {});
        await s.mutate(create(2));
      },
      client,
      'write',
      3
    );
    expect(r.ok).toBe(true);
    expect(calls.mutate).toBe(2);
    expect(r.stats.writes).toBe(2);
  });

  it('applies the cap in dry-run, so dry-run fails where write would', async () => {
    const { client } = fakeClient(() => ({}));
    const r = await run(
      async (s) => {
        await s.mutate(create(2));
        await s.mutate(create(2));
      },
      client,
      'dry-run',
      3
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/4 frames would exceed --max-writes 3/);
    expect(r.mutations).toHaveLength(1);
  });

  it('waits for a write the script did not await before reporting', async () => {
    const { client, calls } = fakeClient(
      () => ({}),
      () => ({ data: { 'ns/createT': [{}] } })
    );
    const r = await run(
      (s) => {
        void s.mutate(create(1));
        return 'returned';
      },
      client,
      'write'
    );
    expect(r).toMatchObject({ ok: true, result: 'returned' });
    expect(calls.mutate).toBe(1);
    expect(r.mutations).toEqual([expect.objectContaining({ applied: true })]);
  });

  it('marks a refused payload unapplied and a policy-denied one applied for the keys that landed', async () => {
    const rolledBack = fakeClient(
      () => ({}),
      () => ({ data: {}, errors: [{ code: 'missing_required_field', message: 'x' }] })
    );
    const r1 = await run((s) => s.mutate(create(1)), rolledBack.client, 'write');
    expect(r1.mutations[0]).toMatchObject({ applied: false });
    expect(r1.stats.writes).toBe(0);

    const partial = fakeClient(
      () => ({}),
      () => ({ data: { 'ns/createT': [{}] }, errors: [{ code: 'policy_denied', message: 'y' }] })
    );
    const r2 = await run(
      (s) => s.mutate({ ...create(1), 'ns/createU': { params: {} } }),
      partial.client,
      'write'
    );
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/mutate refused for ns\/createU/);
    expect(r2.mutations[0]).toMatchObject({ applied: true });
  });

  it('hands the args to the script, frozen, and echoes them in the report', async () => {
    const { client } = fakeClient(() => ({}));
    const r = await runScript(
      (s) => {
        expect(Object.isFrozen(s.args)).toBe(true);
        return s.args.project;
      },
      { client, kid: null, args: { project: 'substrate' }, log: () => {} }
    );
    expect(r).toMatchObject({ ok: true, result: 'substrate', args: { project: 'substrate' } });
    const none = await runScript((s) => Object.keys(s.args).length, {
      client,
      kid: null,
      log: () => {}
    });
    expect(none).toMatchObject({ result: 0, args: {} });
  });

  it('recalls through the recall/Hit frame, sending fields only when row asks for more', async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = fakeClient((frame) => {
      seen.push(frame);
      return {
        data: { 'recall/Hit': [{ id: 'h1', score: 0.9, row: { id: 'r1', synopsis: 's' } }] }
      };
    });
    const r = await run(async (s) => {
      const hits = await s.recall({ query: 'pack', namespace: 'cortext', type: 'Memory', k: 3 });
      await s.recall({ query: 'pack', namespace: 'cortext', type: 'Memory', row: { body: true } });
      // Typed without a cast: handle fields and body are strings when present.
      expectTypeOf(hits[0]?.row.name).toEqualTypeOf<string | undefined>();
      expectTypeOf(hits[0]?.row.body).toEqualTypeOf<string | undefined>();
      expectTypeOf(hits[0]?.row.id).toEqualTypeOf<string | undefined>();
      return hits.map((h) => h.row.synopsis?.toUpperCase());
    }, client);
    expect(r.result).toEqual(['S']);
    expect(seen[0]).toEqual({
      'recall/Hit': { params: { to: 'pack', namespace: 'cortext', type: 'Memory', k: 3 } }
    });
    expect(seen[1]).toMatchObject({ 'recall/Hit': { fields: { row: { body: true } } } });
    expect(r.stats.queries).toBe(2);
  });
});

describe('s.schema', () => {
  const schemas = {
    ns: {
      schemaVersion: 'v',
      types: { T: { fields: { title: { kind: 'scalar', type: 'string' } } } },
      mutations: {}
    }
  };
  const withSchema = (): SubstrateClient => {
    const { client } = fakeClient(() => ({ data: {} }));
    (client as unknown as { federatedSchema: () => Promise<unknown> }).federatedSchema = async () =>
      schemas;
    return client;
  };

  it('answers the federated schema, one namespace, or one type', async () => {
    const r = await run(
      async (s) => [await s.schema(), await s.schema('ns'), await s.schema('ns', 'T')],
      withSchema()
    );
    expect(r.result).toEqual([schemas, schemas.ns, schemas.ns.types.T]);
  });

  it('throws naming an unknown namespace or type', async () => {
    const r = await run(async (s) => s.schema('nope'), withSchema());
    expect(r).toMatchObject({ ok: false, error: "schema: unknown namespace 'nope'" });
    const t = await run(async (s) => s.schema('ns', 'Nope'), withSchema());
    expect(t).toMatchObject({ ok: false, error: "schema: unknown type 'ns/Nope'" });
  });
});

describe('s.byShortId', () => {
  const ROWS = [
    { id: 'a', shortId: 1, title: 'one' },
    { id: 'b', shortId: 2, title: 'two' },
    { id: 'c', shortId: 3, title: 'three' }
  ];
  type ShortIdFrame = { params: { where: { shortId: { eq?: number; in?: number[] } } } };
  // Answers a `shortId` eq/in filter from ROWS, in store order rather than input order.
  const store = (seen: Record<string, unknown>[] = []) =>
    fakeClient((frame) => {
      seen.push(frame);
      const [key, f] = Object.entries(frame)[0] as [string, ShortIdFrame];
      const p = f.params.where.shortId;
      const ids = p.in ?? [p.eq];
      return { data: { [key]: ROWS.filter((r) => ids.includes(r.shortId)) } };
    }).client;

  it('resolves one shortId to its row through an eq filter', async () => {
    const seen: Record<string, unknown>[] = [];
    const r = await run(async (s) => s.byShortId('ns/Todo', 2), store(seen));
    expect(r.result).toEqual(ROWS[1]);
    expect(seen[0]).toEqual({ 'ns/Todo': { params: { where: { shortId: { eq: 2 } } } } });
  });

  it('returns an array in input order through an in filter, adding shortId to fields', async () => {
    const seen: Record<string, unknown>[] = [];
    const r = await run(
      async (s) => (await s.byShortId('ns/Todo', [3, 1, 3], { title: true })).map((t) => t.title),
      store(seen)
    );
    expect(r.result).toEqual(['three', 'one', 'three']);
    expect(seen[0]).toEqual({
      'ns/Todo': {
        params: { where: { shortId: { in: [3, 1] } } },
        fields: { title: true, shortId: true }
      }
    });
  });

  it('throws naming every missing shortId', async () => {
    const r = await run(async (s) => s.byShortId('ns/Todo', [1, 8, 9]), store());
    expect(r).toMatchObject({ ok: false, error: 'ns/Todo: no row with shortId 8, 9' });
  });

  it('answers an empty array without a query', async () => {
    const r = await run(async (s) => s.byShortId('ns/Todo', []), store());
    expect(r).toMatchObject({ ok: true, result: [], stats: { queries: 0 } });
  });
});

describe('s.act', () => {
  const actClient = (reply: unknown) => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      act: async (req: Record<string, unknown>) => {
        sent.push(req);
        return reply;
      }
    } as unknown as SubstrateClient;
    return { client, sent };
  };
  const ok = { ok: true, ack: 'closed Todo #1', result: 'r_1' };

  it('sends dry-run in read mode', async () => {
    const { client, sent } = actClient(ok);
    const r = await run((s) => s.act('close Todo #1'), client);
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ sketch: 'close Todo #1', mode: 'dry-run' }]);
  });

  it('sends write in write mode, counts each call, and stops past maxWrites', async () => {
    const { client, sent } = actClient(ok);
    const r = await run(
      async (s) => {
        await s.act('close Todo #1', { namespace: 'cortext' });
        await s.act('close Todo #2');
      },
      client,
      'write',
      1
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceed --max-writes 1/);
    expect(sent).toEqual([{ sketch: 'close Todo #1', mode: 'write', namespace: 'cortext' }]);
    expect(r.stats.writes).toBe(1);
  });

  it('throws on a refusal and gives the count back', async () => {
    const { client } = actClient({
      ok: false,
      refusal: {
        code: 'sketch_unresolved',
        step: 1,
        token: 'x',
        problem: 'unknown',
        choices: [],
        nearest: null
      }
    });
    const r = await run(
      async (s) => {
        await s.act('x').catch(() => {});
        await s.act('y');
      },
      client,
      'write',
      1
    );
    expect(r.error).toMatch(/^act refused at step 1: unknown/);
  });

  it('throws on a failure naming step, code and message', async () => {
    const { client } = actClient({
      ok: false,
      error: { code: 'not_found', message: 'no row', step: 2 },
      result: 'r_2'
    });
    const r = await run((s) => s.act('x'), client);
    expect(r.error).toMatch(/act failed at step 2: not_found: no row/);
  });
});
