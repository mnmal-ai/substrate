import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runAct } from '../src/cli/act/main.js';
import { runCli } from '../src/cli.js';

vi.mock('../src/mcp/server.js', () => ({ runMcp: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main.js', () => ({ runServe: vi.fn().mockResolvedValue(undefined) }));

const dir = mkdtempSync(join(tmpdir(), 'act-cli-'));
const keyPath = join(dir, 'k.pem');
writeFileSync(
  keyPath,
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env: NodeJS.ProcessEnv = {
  SUBSTRATE_URL: 'http://127.0.0.1:3100',
  SUBSTRATE_NAMESPACE: 'work',
  SUBSTRATE_AGENT_KEY_ID: 'k',
  SUBSTRATE_AGENT_KEY_PATH: keyPath
};

interface Seen {
  url?: string;
  method?: string | undefined;
  body?: unknown;
}
const fake = (reply: unknown, seen: Seen = {}, status = 200): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.method = init.method;
    if (init.body !== undefined) seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

const run = async (
  argv: string[],
  reply: unknown = {},
  seen: Seen = {},
  e: NodeJS.ProcessEnv = env
) => {
  let out = '';
  const code = await runAct(argv, {
    env: e,
    fetchImpl: fake(reply, seen),
    write: (s) => (out += s)
  });
  return { code, out };
};

describe('substrate act', () => {
  it('an ok reply prints the ack and the result id', async () => {
    const seen: Seen = {};
    const r = await run(
      ['close', 'Todo', '#1'],
      { ok: true, ack: 'closed work/Todo #1', result: 'r_x' },
      seen
    );
    expect(r).toEqual({ code: 0, out: 'closed work/Todo #1\nresult r_x\n' });
    expect(seen.body).toEqual({ sketch: 'close Todo #1', namespace: 'work' });
  });

  it('a refusal prints step, problem, choices and nearest, and exits 1', async () => {
    const r = await run(['x'], {
      ok: false,
      refusal: {
        code: 'sketch_unresolved',
        step: 2,
        token: 'x',
        problem: 'no such type',
        choices: ['a', 'b'],
        nearest: 'Todo'
      }
    });
    expect(r).toEqual({
      code: 1,
      out: 'refused at step 2: no such type\n  choices: a, b\n  nearest: Todo\n'
    });
    const bare = await run(['x'], {
      ok: false,
      refusal: { step: 1, problem: 'p', choices: [], nearest: null }
    });
    expect(bare.out).toBe('refused at step 1: p\n');
  });

  it('a failure prints the code, message and result id, and exits 1', async () => {
    const r = await run(['x'], {
      ok: false,
      error: { code: 'not_found', message: 'gone', step: 2 },
      result: 'r_y'
    });
    expect(r).toEqual({ code: 1, out: 'failed at step 2: not_found: gone\nresult r_y\n' });
  });

  it('a failure or refusal with no step names none', async () => {
    const failed = await run(['x'], {
      ok: false,
      error: { code: 'unauthorized', message: 'act needs a signed caller' },
      result: null
    });
    expect(failed).toEqual({ code: 1, out: 'failed: unauthorized: act needs a signed caller\n' });
    const refused = await run(['x'], {
      ok: false,
      refusal: { step: null, problem: 'p', choices: [], nearest: null }
    });
    expect(refused.out).toBe('refused: p\n');
  });

  it('help prints the help JSON; --json prints any reply as JSON', async () => {
    const help = await run(['?'], { ok: true, help: { types: { work: { Todo: ['close'] } } } });
    expect(help.code).toBe(0);
    expect(JSON.parse(help.out)).toEqual({ types: { work: { Todo: ['close'] } } });
    const both = await run(['?', 'Todo;', 'count', 'Todo'], {
      ok: true,
      ack: 'work/Todo count 2',
      result: 'r1',
      help: { type: 'work/Todo' }
    });
    expect(both.code).toBe(0);
    expect(both.out.endsWith('work/Todo count 2\nresult r1\n')).toBe(true);
    expect(JSON.parse(both.out.slice(0, both.out.indexOf('work/Todo count')))).toEqual({
      type: 'work/Todo'
    });
    const refusal = { ok: false, refusal: { step: 1, problem: 'p', choices: [], nearest: null } };
    const j = await run(['--json', 'x'], refusal);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out)).toEqual(refusal);
  });

  it('--dry-run, --key and --ns reach the request', async () => {
    const seen: Seen = {};
    await run(
      ['--dry-run', '--key', 'k1', '--ns', 'other', 'close', 'Todo', '#1'],
      { ok: true, ack: 'a', result: 'r' },
      seen
    );
    expect(seen.body).toEqual({
      sketch: 'close Todo #1',
      mode: 'dry-run',
      idempotencyKey: 'k1',
      namespace: 'other'
    });
  });

  it('--result GETs the result route and prints the record', async () => {
    const seen: Seen = {};
    const r = await run(['--result', 'r_x'], { id: 'r_x', ok: true }, seen);
    expect(seen.method).toBe('GET');
    expect(seen.url).toMatch(/\/act\/.*r_x$/);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ id: 'r_x', ok: true });
  });

  it('usage errors exit 2', async () => {
    for (const argv of [
      [],
      ['--ns'],
      ['--ns', '--json', 'x'],
      ['--result'],
      ['--result', 'r', 'x']
    ]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/^usage: substrate act /);
    }
  });

  it('-- ends flags', async () => {
    const seen: Seen = {};
    await run(['--', '--weird', 'x'], { ok: true, ack: 'a', result: null }, seen);
    expect(seen.body).toEqual({ sketch: '--weird x', namespace: 'work' });
  });

  it('a missing or broken agent key exits 2', async () => {
    for (const e of [
      { SUBSTRATE_URL: 'http://127.0.0.1:3100' },
      { ...env, SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/key' }
    ]) {
      const r = await run(['x'], {}, {}, e);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/^substrate act: agent identity: .*\n$/);
    }
  });

  it('a network or HTTP error is one sanitised line, exit 1', async () => {
    let out = '';
    const code = await runAct(['x'], {
      env,
      fetchImpl: fake({ message: 'bad\x1b[31m thing' }, {}, 500),
      write: (s) => (out += s)
    });
    expect(code).toBe(1);
    expect(out).toMatch(/^substrate act: [^\n]*\n$/);
    expect(out).not.toContain('\x1b');
  });

  it('server text is stripped of terminal escapes', async () => {
    const r = await run(['x'], { ok: true, ack: 'a\x1b[31mb', result: 'r' });
    expect(r.out).toBe('ab\nresult r\n');
  });

  it('a non-numeric step is printed as ?, never raw', async () => {
    const evil = '\x1b]0;pwned\x07';
    const refused = await run(['x'], {
      ok: false,
      refusal: { step: evil, problem: 'p', choices: [], nearest: null }
    });
    const failed = await run(['x'], {
      ok: false,
      error: { code: 'c', message: 'm', step: evil },
      result: 'r'
    });
    expect(refused.out).toBe('refused at step ?: p\n');
    expect(failed.out).toBe('failed at step ?: c: m\nresult r\n');
    expect(refused.out + failed.out).not.toContain('\x1b');
  });

  it('is dispatched and listed in help', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runCli(['--help']);
      expect(spy.mock.calls.map((c) => String(c[0])).join('')).toContain('act <sketch>');
      spy.mockClear();
      expect(await runCli(['act'])).toBe(2);
      expect(spy.mock.calls.map((c) => String(c[0])).join('')).toContain('usage: substrate act');
    } finally {
      spy.mockRestore();
    }
  });
});
