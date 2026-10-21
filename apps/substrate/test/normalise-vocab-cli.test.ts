import { describe, expect, it } from 'vitest';
import { runNormaliseVocab } from '../src/cli/normalise-vocab/main.js';

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const base = { baseUrl: 'https://h.example:3100', token: 'tok' };

describe('substrate normalise-vocab', () => {
  it('dry-runs by default, posting the target and printing the plan', async () => {
    const { calls, fetchImpl } = stub(200, {
      applied: false,
      plan: [{ from: 'accepted', to: 'active', count: 21 }],
      unmapped: [{ value: 'weird', count: 1 }],
      scanned: 450,
      truncated: false
    });
    let out = '';
    const code = await runNormaliseVocab(['cortext', 'Decision', 'status'], {
      ...base,
      fetchImpl,
      write: (t) => {
        out += t;
      }
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://h.example:3100/substrate/v1/_system/normalise-vocab');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      namespace: 'cortext',
      type: 'Decision',
      field: 'status',
      apply: false,
      reject: []
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out).toContain('accepted -> active  21');
    expect(out).toContain('weird  1');
    expect(out).toContain('dry run');
  });

  it('passes --apply and --reject', async () => {
    const { calls, fetchImpl } = stub(200, {
      applied: true,
      migrated: [],
      stranded: [],
      plan: [],
      unmapped: []
    });
    await runNormaliseVocab(['cortext', 'Decision', 'status', '--apply', '--reject', 'weird,odd'], {
      ...base,
      fetchImpl,
      write: () => {}
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      apply: true,
      reject: ['weird', 'odd']
    });
  });

  it('exits 1 when the server refuses unmapped values, naming them', async () => {
    const { fetchImpl } = stub(409, {
      code: 'unmapped_values',
      unmapped: [{ value: 'weird', count: 1 }]
    });
    let out = '';
    expect(
      await runNormaliseVocab(['cortext', 'Decision', 'status', '--apply'], {
        ...base,
        fetchImpl,
        write: (t) => {
          out += t;
        }
      })
    ).toBe(1);
    expect(out).toContain('weird');
  });

  it('exits 2 on bad usage or a missing SUBSTRATE_URL', async () => {
    expect(await runNormaliseVocab(['cortext'], { ...base, write: () => {} })).toBe(2);
    expect(
      await runNormaliseVocab(['cortext', 'Decision', 'status'], {
        token: 'x',
        baseUrl: '',
        write: () => {}
      })
    ).toBe(2);
  });
});
