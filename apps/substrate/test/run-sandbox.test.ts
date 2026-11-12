import type { SubstrateClient } from '@mnmal-ai/substrate-client';
import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { runSandboxed } from '../src/mcp/run-sandbox.js';

function fakeClient(): { client: SubstrateClient; mutated: unknown[] } {
  const mutated: unknown[] = [];
  const env = (data: Record<string, unknown>): PackEnvelope =>
    ({ schemaVersion: 'v', shapes: {}, data }) as PackEnvelope;
  const client = {
    query: async () => env({ 'ns/T': [{ id: '1', n: 9223372036854775807n }] }),
    mutate: async (frame: Record<string, unknown>) => {
      mutated.push(frame);
      return env({ 'ns/createT': { id: 'new' } });
    },
    federatedSchema: async () => ({ ns: { schemaVersion: 'v', types: { T: {} }, mutations: {} } })
  } as unknown as SubstrateClient;
  return { client, mutated };
}

const run = (source: string, opts: Partial<Parameters<typeof runSandboxed>[1]> = {}) =>
  runSandboxed(source, { kid: 'a@h', log: () => {}, ...fakeClient(), ...opts });

describe('runSandboxed', () => {
  it('relays the context: args, query, schema, and a bigint across the hop', async () => {
    const r = await run(
      `export default async (s) => {
        const rows = (await s.query({ 'ns/T': {} })).data['ns/T'];
        return { who: s.kid, mode: s.mode, p: s.args.p, n: rows[0].n, types: Object.keys((await s.schema('ns')).types) };
      };`,
      { args: { p: 'x' } }
    );
    expect(r).toMatchObject({
      ok: true,
      result: { who: 'a@h', mode: 'read', p: 'x', n: 9223372036854775807n, types: ['T'] }
    });
    expect(r.stats.queries).toBe(1);
  });

  it('strips TypeScript type syntax from the script', async () => {
    const r = await run(
      `import type { ScriptContext } from '@mnmal-ai/substrate/client';
       export default async (s: ScriptContext): Promise<number> => 1 + 1;`
    );
    expect(r).toMatchObject({ ok: true, result: 2 });
  });

  it('keeps the modes: read refuses mutate, write applies and counts it, maxWrites caps it', async () => {
    const script = `export default async (s) => s.mutate({ 'ns/createT': { params: {} } });`;
    expect(await run(script)).toMatchObject({
      ok: false,
      error: expect.stringContaining('read mode')
    });

    const { client, mutated } = fakeClient();
    const w = await run(script, { client, mode: 'write' });
    expect(w).toMatchObject({ ok: true, stats: { writes: 1 } });
    expect(w.mutations).toHaveLength(1);
    expect(mutated).toHaveLength(1);

    const capped = await run(script, { mode: 'write', maxWrites: 0 });
    expect(capped).toMatchObject({ ok: false, error: expect.stringContaining('max-writes') });
  });

  it.each([
    ['reading a file', `(await import('node:fs')).readFileSync('/etc/hostname', 'utf8')`],
    ['writing a file', `(await import('node:fs')).writeFileSync('/tmp/substrate-run-escape', 'x')`],
    ['spawning a process', `(await import('node:child_process')).execFileSync('true')`],
    [
      'opening a socket',
      `await new Promise((res, rej) => { import('node:net').then((net) => { const k = net.connect(9, '127.0.0.1'); k.on('error', rej); k.on('connect', res); }, rej); })`
    ],
    ['starting a worker', `new (await import('node:worker_threads')).Worker('1', { eval: true })`]
  ])('denies %s with ERR_ACCESS_DENIED', async (_what, body) => {
    // The script reports the error it met, so a child that never started cannot pass for a denial.
    const r = await run(
      `export default async () => { try { ${body}; return 'escaped'; } catch (e) { return e.code ?? e.message; } };`
    );
    expect(r).toMatchObject({ ok: true, result: 'ERR_ACCESS_DENIED' });
  });

  it('starts the script with an empty environment', async () => {
    const r = await run(`export default async () => Object.keys(process.env).length;`);
    expect(r).toMatchObject({ ok: true, result: 0 });
  });

  it('kills a script that runs past the timeout', async () => {
    const t0 = performance.now();
    const r = await run(`export default async () => { for (;;) {} };`, { timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, error: 'script timed out after 500 ms' });
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('reports a script without a default export', async () => {
    const r = await run(`export const x = 1;`);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('default-export') });
  });
});
