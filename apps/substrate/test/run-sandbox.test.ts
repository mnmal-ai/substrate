import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubstrateClient } from '@mnmal-ai/substrate-client';
import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { osJail, runSandboxed } from '../src/mcp/run-sandbox.js';

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
  it('logs a bigint and a cyclic object without failing the run', async () => {
    const lines: string[] = [];
    const r = await run(
      `export default async (s) => {
        const loop = {}; loop.self = loop;
        s.log('n', 1n); s.log(loop);
        await s.query({ 'ns/T': {} });
        return 'ok';
      };`,
      { log: (l) => lines.push(l) }
    );
    expect(r).toMatchObject({ ok: true, result: 'ok' });
    expect(lines[0]).toBe('n 1');
  });

  it('stops the script when the caller cancels', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const r = await run(`export default () => new Promise((r) => setTimeout(r, 20000));`, {
      signal: ac.signal
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancelled/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('caps writes the script sends at once', async () => {
    const fake = fakeClient();
    const r = await run(
      `export default (s) => Promise.all(Array.from({ length: 10 }, () => s.mutate('ns/createT', { params: {} })));`,
      { ...fake, mode: 'write', maxWrites: 3 }
    );
    expect(r.ok).toBe(false);
    expect(fake.mutated).toHaveLength(3);
  });

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

  it('relays the (key, entry) forms of query and mutate', async () => {
    const r = await run(
      `export default async (s) => {
        const rows = (await s.query('ns/T', { fields: { id: true } })).data['ns/T'];
        await s.mutate('ns/createT', { params: {} });
        return rows[0].id;
      };`,
      { mode: 'write' }
    );
    expect(r).toMatchObject({
      ok: true,
      result: '1',
      mutations: [{ frame: { 'ns/createT': { params: {} } }, applied: true }]
    });
  });

  it('relays byShortId, a helper the child forwards rather than reimplements', async () => {
    const env = (data: Record<string, unknown>): PackEnvelope =>
      ({ schemaVersion: 'v', shapes: {}, data }) as PackEnvelope;
    const client = {
      query: async () =>
        env({
          'ns/T': [
            { id: 'a', shortId: 1 },
            { id: 'b', shortId: 2 }
          ]
        })
    } as unknown as SubstrateClient;
    const r = await run(
      `export default async (s) => (await s.byShortId('ns/T', [2, 1])).map((t) => t.id);`,
      { client }
    );
    expect(r).toMatchObject({ ok: true, result: ['b', 'a'] });
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

  it('gives the script no way to signal a process', async () => {
    // Signal 0 only probes, so a script that could send it could send any other.
    // `_debugProcess` sends a real SIGUSR1, so it is aimed at a pid nothing holds.
    const r = await run(
      `export default async (s) => {
        const { pid, nobody } = s.args;
        const calls = [
          () => process.kill(pid, 0),
          () => process._kill(pid, 0),
          async () => (await import('node:process')).kill(pid, 0),
          () => process._debugProcess(nobody),
          () => process._debugEnd(nobody),
          () => process.binding('process_wrap'),
          () => process._linkedBinding('process_wrap'),
          () => process.dlopen({ exports: {} }, '/nonexistent.node')
        ];
        const out = [];
        for (const call of calls) {
          try { await call(); out.push('sent'); } catch (e) { out.push(e.message); }
        }
        return out;
      };`,
      { args: { pid: process.pid, nobody: 4_194_303 } }
    );
    expect(r).toMatchObject({
      ok: true,
      result: Array(8).fill('a script cannot signal a process')
    });
  });

  it.runIf(osJail() !== null)(
    'starts the script in namespaces of its own where bubblewrap is available',
    async () => {
      const r = await run(
        `export default async (s) => {
          const os = await import('node:os');
          let reach;
          try { process.kill(s.args.pid, 0); reach = 'reached'; } catch (e) { reach = e.message; }
          return { pid: process.pid, ppid: process.ppid, nics: Object.keys(os.networkInterfaces()), reach };
        };`,
        { args: { pid: process.pid } }
      );
      // A handful of processes exist in the namespace, and no network device beyond loopback.
      expect(r).toMatchObject({ ok: true });
      const seen = r.result as { pid: number; ppid: number; nics: string[] };
      expect(seen.pid).toBeLessThan(10);
      expect(seen.ppid).toBeLessThan(10);
      expect(seen.nics.filter((n) => n !== 'lo')).toEqual([]);
    }
  );

  it('kills a script that runs past the timeout', async () => {
    const t0 = performance.now();
    const r = await run(`export default async () => { for (;;) {} };`, { timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, error: 'script timed out after 500 ms' });
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('refuses to run a script when the permission model is not active', async () => {
    // The runner started without the flags, as a runtime that ignores them would start it.
    const runner = fileURLToPath(new URL('../src/mcp/script-runner.ts', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'substrate-run-test-'));
    const marker = join(dir, 'ran');
    const script = join(dir, 'script.mjs');
    writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs'; export default async (s) => writeFileSync(s.args.marker, '1');"
    );
    const child = fork(runner, [], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const done = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      child.on('message', (m: { type: string; ok: boolean; error?: string }) => {
        if (m.type === 'done') resolve(m);
      });
      child.send({ type: 'start', script, kid: null, mode: 'read', args: { marker } });
    });
    child.kill();
    expect(done).toMatchObject({ ok: false, error: expect.stringContaining('not active') });
    expect(existsSync(marker)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a script without a default export', async () => {
    const r = await run(`export const x = 1;`);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('default-export') });
  });
});
