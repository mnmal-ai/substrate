import { describe, expect, it } from 'vitest';
import { runAsk } from '../src/cli/ask/main.js';

const fake = (outcome: unknown, seen: { body?: unknown; url?: string } = {}): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ outcome, trail: [{ event: 'parsed', status: 'resolved' }] }),
      {
        headers: { 'content-type': 'application/json' }
      }
    );
  }) as unknown as typeof fetch;

describe('substrate ask', () => {
  it('requires SUBSTRATE_URL and a question', async () => {
    let out = '';
    expect(await runAsk(['open todos'], { env: {}, write: (s) => (out += s) })).toBe(2);
    expect(out).toMatch(/SUBSTRATE_URL/);
    expect(
      await runAsk([], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        write: () => {}
      })
    ).toBe(2);
  });

  it('takes --ns from SUBSTRATE_NAMESPACE, and --project from the cwd basename', async () => {
    const seen: { body?: unknown; url?: string } = {};
    const rows = {
      kind: 'rows',
      source: 'parser',
      answer: 'rows',
      frame: { 'cortext/Todo': {} },
      data: [{ id: '1', title: 'x' }]
    };
    expect(
      await runAsk(['open', 'todos'], {
        env: { SUBSTRATE_URL: 'http://h/', SUBSTRATE_NAMESPACE: 'notes' },
        cwd: '/x/substrate',
        fetchImpl: fake(rows, seen),
        write: () => {}
      })
    ).toBe(0);
    expect(seen.url).toBe('http://h/substrate/v1/nl');
    expect(seen.body).toEqual({
      namespace: 'notes',
      question: 'open todos',
      project: 'substrate'
    });
  });

  it('human output leads with the frame line', async () => {
    let out = '';
    const rows = {
      kind: 'rows',
      source: 'parser',
      answer: 'rows',
      frame: { 'cortext/Todo': {} },
      data: [{ id: '1', title: 'x' }]
    };
    await runAsk(['--ns', 'cortext', 'open todos'], {
      env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
      cwd: '/r',
      fetchImpl: fake(rows),
      write: (s) => (out += s)
    });
    expect(out.split('\n')[0]).toBe('▸ cortext/Todo · parser · 1 rows');
  });

  it('--json prints the raw { outcome, trail }; refuse exits 1', async () => {
    let out = '';
    const code = await runAsk(['--json', 'close todo 1'], {
      env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
      cwd: '/r',
      fetchImpl: fake({ kind: 'refuse', reason: 'edit' }),
      write: (s) => (out += s)
    });
    expect(code).toBe(1);
    expect(JSON.parse(out).outcome.kind).toBe('refuse');
  });

  const run = async (
    argv: string[],
    outcome: unknown,
    env: NodeJS.ProcessEnv = { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' }
  ) => {
    let out = '';
    const code = await runAsk(argv, {
      env,
      cwd: '/r',
      fetchImpl: fake(outcome),
      write: (s) => (out += s)
    });
    return { code, out };
  };

  it('renders recall hits, and rejected recall without hits', async () => {
    const hit = await run(['q'], {
      kind: 'recall',
      hits: [{ type: 'Memory', id: 'm1', score: 0.5 }]
    });
    expect(hit.code).toBe(0);
    expect(hit.out).toContain('▸ recall · 1 hits');
    expect(hit.out).toContain('Memory m1  0.50');
    const none = await run(['q'], { kind: 'recall', errors: [{ code: 'x' }] });
    expect(none.out).toContain('▸ recall · rejected');
    expect(none.out).toContain('"code":"x"');
  });

  it('renders clarify with and without options, and refuse', async () => {
    const c = await run(['q'], { kind: 'clarify', reason: 'which?', options: [{ label: 'A' }] });
    expect(c.out).toBe('? which?\n  1. A\n');
    expect((await run(['q'], { kind: 'clarify', reason: 'which?' })).out).toBe('? which?\n');
    const r = await run(['q'], { kind: 'refuse', reason: 'edit' });
    expect(r.out).toBe('✗ edit\n');
    expect(r.code).toBe(1);
  });

  it('unknown prints the dropped list and the plan, and exits 1', async () => {
    const r = await run(['q'], {
      kind: 'unknown',
      question: 'q',
      dropped: [{ span: 'past 2 days', reason: 'it windows Island', kind: 'filter' }],
      plan: [{ path: ['where', '_walk', 'cards/Listing.cert', 'any'], kind: 'hop', served: true }]
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('? unknown');
    expect(r.out).toContain('  dropped "past 2 days": it windows Island\n');
    expect(r.out).toContain('  plan where._walk.cards/Listing.cert.any (hop)\n');
  });

  it('terminal escapes in server-derived text are neutralised', async () => {
    const evil = '\x1b]0;pwned\x07Ship\x1b[31mit';
    const r = await run(['q'], {
      kind: 'unknown',
      question: evil,
      dropped: [{ span: evil, reason: evil, kind: 'filter' }],
      plan: [{ path: [evil], kind: 'filter', served: false }]
    });
    expect(r.out).not.toContain('\x1b');
    expect(r.out).not.toContain('\x07');
    expect(r.out).toContain('dropped "Shipit": Shipit');
    const rows = await run(['q'], {
      kind: 'rows',
      source: 'parser',
      frame: { 'a/B': {} },
      data: [{ id: evil, title: evil }],
      dropped: [],
      plan: []
    });
    expect(rows.out).not.toContain('\x1b');
  });

  it('rows print what was dropped; a server count prints the number', async () => {
    const r = await run(['q'], {
      kind: 'rows',
      source: 'handoff',
      frame: { 'a/B': {} },
      answer: 'count',
      data: { count: 7 },
      count: 7,
      dropped: [{ span: 'latest', reason: 'conflicts', kind: 'order' }],
      plan: []
    });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toBe('▸ a/B · handoff · count 7');
    expect(r.out).toContain('  dropped "latest": conflicts\n');
  });

  it('rows with errors exit 1 and print them', async () => {
    const r = await run(['q'], {
      kind: 'rows',
      source: 'parser',
      frame: { 'a/B': {} },
      data: [],
      errors: [{ code: 'bad' }]
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ {"code":"bad"}');
  });

  it('a rejected rows outcome (no data) says rejected, never "0 rows"', async () => {
    const r = await run(['q'], {
      kind: 'rows',
      source: 'handoff',
      handoff: 'judge unavailable',
      frame: { 'a/B': {} },
      errors: [{ code: 'unknown_operator' }]
    });
    expect(r.out.split('\n')[0]).toBe('▸ a/B · handoff (judge unavailable) · rejected');
    expect(r.out).not.toContain('0 rows');
    expect(r.out).toContain('✗ {"code":"unknown_operator"}');
    expect(r.code).toBe(1);
  });

  it('a 404 naming the namespace is printed as such; a bodiless 404 is the absent route', async () => {
    let out = '';
    const unknownNs = (async () =>
      new Response(
        JSON.stringify({ error: "unknown namespace 'x'", code: 'nl_unknown_namespace' }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' }
        }
      )) as unknown as typeof fetch;
    expect(
      await runAsk(['--ns', 'x', 'q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        fetchImpl: unknownNs,
        write: (s) => (out += s)
      })
    ).toBe(1);
    expect(out).toBe("substrate ask: unknown namespace 'x'\n");
  });

  it("the server framework's default JSON 404 (route absent) still gets the install hint", async () => {
    let out = '';
    const fastify404 = (async () =>
      new Response(
        JSON.stringify({
          message: 'Route POST:/substrate/v1/nl not found',
          error: 'Not Found',
          statusCode: 404
        }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' }
        }
      )) as unknown as typeof fetch;
    expect(
      await runAsk(['q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        fetchImpl: fastify404,
        write: (s) => (out += s)
      })
    ).toBe(1);
    expect(out).toBe(
      'substrate ask: the server has no NL route (is @mnmal-ai/substrate-nl installed?)\n'
    );
  });

  it('a 404 says the NL route is absent; other failures are one line, no stack', async () => {
    let out = '';
    const f404 = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(
      await runAsk(['q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        fetchImpl: f404,
        write: (s) => (out += s)
      })
    ).toBe(1);
    expect(out).toBe(
      'substrate ask: the server has no NL route (is @mnmal-ai/substrate-nl installed?)\n'
    );
    out = '';
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(
      await runAsk(['q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        fetchImpl: down,
        write: (s) => (out += s)
      })
    ).toBe(1);
    expect(out).toMatch(/^substrate ask: POST http:\/\/h\/substrate\/v1\/nl failed\n$/);
    out = '';
    const f401 = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    expect(
      await runAsk(['q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        fetchImpl: f401,
        write: (s) => (out += s)
      })
    ).toBe(1);
    expect(out).toMatch(/^substrate ask: .*\n$/);
  });

  it('a server error message is stripped of terminal escapes', async () => {
    let out = '';
    const evil = (async () =>
      new Response(JSON.stringify({ message: 'bad\x1b]0;pwned\x07 \x1b[31mthing' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch;
    expect(
      await runAsk(['q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        fetchImpl: evil,
        write: (s) => (out += s)
      })
    ).toBe(1);
    expect(out).toBe('substrate ask: bad thing\n');
  });

  it('--json escapes C1 controls, which JSON.stringify leaves raw', async () => {
    let out = '';
    await runAsk(['--json', 'q'], {
      env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
      fetchImpl: fake({ kind: 'refuse', reason: 'a\u009b31mb\u009d0;x' }),
      write: (s) => (out += s)
    });
    expect(out).not.toMatch(/[\u0080-\u009f]/);
    expect(out).toContain('a\\u009b31mb\\u009d0;x');
    expect(JSON.parse(out).outcome.reason).toBe('a\u009b31mb\u009d0;x');
  });

  it('a value flag does not swallow another flag; -- ends flags', async () => {
    expect(
      await runAsk(['--ns', '--json', 'q'], {
        env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
        write: () => {}
      })
    ).toBe(2);
    const seen: { body?: unknown; url?: string } = {};
    const rows = { kind: 'rows', source: 'parser', frame: { 'a/B': {} }, data: [] };
    await runAsk(['--', '--weird', 'question'], {
      env: { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: 'notes' },
      cwd: '/r',
      fetchImpl: fake(rows, seen),
      write: () => {}
    });
    expect(seen.body).toEqual({ namespace: 'notes', question: '--weird question', project: 'r' });
  });

  it('needs a namespace: there is no default', async () => {
    let out = '';
    for (const env of [
      { SUBSTRATE_URL: 'http://h' },
      { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: '' }
    ]) {
      expect(await runAsk(['q'], { env, write: (s) => (out += s) })).toBe(2);
    }
    expect(out).toMatch(/--ns or SUBSTRATE_NAMESPACE/);
  });

  it('a set-but-broken signing key is a clean config error, exit 2', async () => {
    let out = '';
    const code = await runAsk(['q'], {
      env: {
        SUBSTRATE_URL: 'http://h',
        SUBSTRATE_NAMESPACE: 'notes',
        SUBSTRATE_AGENT_KEY_ID: 'k',
        SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/key'
      },
      write: (s) => (out += s)
    });
    expect(code).toBe(2);
    expect(out).toMatch(/^substrate ask: agent identity: .*\n$/);
  });
});
