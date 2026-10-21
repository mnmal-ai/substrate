import { describe, expect, it } from 'vitest';
import { runBackfillField } from '../src/cli/backfill-field/main.js';

function harness(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let out = '';
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return {
    calls,
    opts: {
      baseUrl: 'https://h',
      token: 't',
      fetchImpl,
      write: (s: string) => {
        out += s;
      },
      readFile: () => JSON.stringify({ a: 'completed', b: 'wont_do' })
    },
    get out() {
      return out;
    }
  };
}

describe('substrate backfill-field', () => {
  it('dry-runs by default, signed, and prints counts', async () => {
    const h = harness([
      {
        status: 200,
        body: { write: 2, counts: { completed: 1, wont_do: 1 }, kept: 0, missing: [] }
      }
    ]);
    const code = await runBackfillField(
      ['cortext', 'Todo', 'resolution', '--values', 'v.json'],
      h.opts
    );
    expect(code).toBe(0);
    const sent = JSON.parse(String(h.calls[0]?.init.body));
    expect(sent).toMatchObject({ apply: false, overwrite: false, values: { a: 'completed' } });
    expect((h.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(h.out).toMatch(/would write \(dry run; pass --apply\) 2/);
  });

  it('exits 1 and lists the refused values', async () => {
    const h = harness([
      {
        status: 400,
        body: {
          code: 'invalid_values',
          message: '1 value',
          invalid: [{ id: 'b', value: 'x', reason: 'not in ...' }]
        }
      }
    ]);
    const code = await runBackfillField(
      ['cortext', 'Todo', 'resolution', '--values', 'v.json', '--apply'],
      h.opts
    );
    expect(code).toBe(1);
    expect(h.out).toContain('b: x');
  });

  it('needs --values', async () => {
    const h = harness([]);
    expect(await runBackfillField(['cortext', 'Todo', 'resolution'], h.opts)).toBe(2);
  });

  it('a refused second chunk exits 1, prints the refusal, and says how many chunks were written', async () => {
    const big = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`r${i}`, 'completed']));
    const h = harness([
      { status: 200, body: { write: 5000, counts: { completed: 5000 }, kept: 0, missing: [] } },
      {
        status: 400,
        body: {
          code: 'invalid_values',
          message: 'bad',
          invalid: [{ id: 'r5000', value: 'x', reason: 'enum' }]
        }
      }
    ]);
    const code = await runBackfillField(
      ['cortext', 'Todo', 'resolution', '--values', 'v.json', '--apply'],
      { ...h.opts, readFile: () => JSON.stringify(big) }
    );
    expect(code).toBe(1);
    expect(h.out).toMatch(/HTTP 400: invalid_values bad/);
    expect(h.out).toMatch(/r5000: x \(enum\)/);
    expect(h.out).toMatch(/1 of 2 chunk\(s\) were written before the refusal/);
  });

  it('a 500 on the only chunk exits 2 and says the failing chunk state is unknown', async () => {
    const h = harness([{ status: 500, body: { code: 'verify_failed', message: 'mismatch' } }]);
    const code = await runBackfillField(
      ['cortext', 'Todo', 'resolution', '--values', 'v.json', '--apply'],
      h.opts
    );
    expect(code).toBe(2);
    expect(h.out).toMatch(/HTTP 500: verify_failed/);
    expect(h.out).toContain("the failing chunk's own state is unknown");
  });

  it('a transport failure surfaces the underlying reason', async () => {
    const h = harness([]);
    const code = await runBackfillField(['cortext', 'Todo', 'resolution', '--values', 'v.json'], {
      ...h.opts,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      }) as unknown as typeof fetch
    });
    expect(code).toBe(2);
    expect(h.out).toContain('ECONNREFUSED');
  });
  it('a 401 exits 2 and prints the status and server message', async () => {
    const h = harness([{ status: 401, body: { message: 'bad signature' } }]);
    const code = await runBackfillField(
      ['cortext', 'Todo', 'resolution', '--values', 'v.json', '--apply'],
      h.opts
    );
    expect(code).toBe(2);
    expect(h.out).toMatch(/^HTTP 401: +bad signature$/m);
  });

  it('a 403 exits 2 and prints the status, code and server message', async () => {
    const h = harness([
      { status: 403, body: { code: 'destructive_ops_disabled', message: 'set the flag' } }
    ]);
    const code = await runBackfillField(
      ['cortext', 'Todo', 'resolution', '--values', 'v.json', '--apply'],
      h.opts
    );
    expect(code).toBe(2);
    expect(h.out).toMatch(/^HTTP 403: destructive_ops_disabled set the flag$/m);
  });
});
