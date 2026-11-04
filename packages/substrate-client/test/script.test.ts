import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
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
      return hits.map((h) => h.row.synopsis);
    }, client);
    expect(r.result).toEqual(['s']);
    expect(seen[0]).toEqual({
      'recall/Hit': { params: { to: 'pack', namespace: 'cortext', type: 'Memory', k: 3 } }
    });
    expect(seen[1]).toMatchObject({ 'recall/Hit': { fields: { row: { body: true } } } });
    expect(r.stats.queries).toBe(2);
  });
});
