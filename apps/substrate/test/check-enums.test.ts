import { describe, expect, it } from 'vitest';
import type { FederatedSchemaLike } from '../src/cli/check-enums/main.js';
import {
  collectEnumFields,
  runCheckEnums,
  tallyOffenders,
  vocabHash
} from '../src/cli/check-enums/main.js';

/**
 * `substrate check-enums`. The scan itself is trivial; what earns tests
 * is the reporting contract, because every interesting failure here is a
 * SILENT one — a truncated scan reading as clean, a null being counted as an
 * offender, a drift exiting 0.
 */

const FEDERATED = {
  cortext: {
    types: {
      AgentRule: {
        fields: {
          rule: { kind: 'scalar', type: 'string' },
          category: { kind: 'scalar', type: 'string', enum: ['git', 'testing', 'tooling'] }
        }
      },
      Todo: {
        fields: {
          status: { kind: 'scalar', type: 'string', enum: ['open', 'done'] },
          // A crossRef carrying an `enum`-shaped key must not be collected —
          // only scalars declare vocabularies.
          owner: { kind: 'crossRef', ns: 'cortext', type: 'Agent' }
        }
      }
    }
  },
  perf: { types: { PerfRun: { fields: { label: { kind: 'scalar', type: 'string' } } } } }
} satisfies FederatedSchemaLike;

/** Build a fetch double serving one federated schema and canned row pages. */
function harness(rowsByKey: Record<string, Array<Record<string, unknown>>>, pageSize = 500) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.endsWith('/substrate/v1/federated-schema')) {
      return new Response(JSON.stringify(FEDERATED), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      { params?: { cursor?: string; limit?: number } }
    >;
    const key = Object.keys(body)[0] as string;
    const offset = Number(body[key]?.params?.cursor ?? 0);
    const all = rowsByKey[key] ?? [];
    const page = all.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < all.length;
    return new Response(
      JSON.stringify({
        data: { [key]: page },
        _pagination: { [key]: { hasMore, ...(hasMore ? { nextCursor: String(nextOffset) } : {}) } }
      }),
      { status: 200 }
    );
  };
  return { fetchImpl, calls };
}

function capture() {
  let text = '';
  return {
    write: (s: string) => (text += s),
    get out() {
      return text;
    }
  };
}

describe('collectEnumFields', () => {
  it('finds only scalar fields that declare a non-empty vocabulary', () => {
    const found = collectEnumFields(FEDERATED);
    expect(found.map((f) => `${f.namespace}/${f.type}.${f.field}`).sort()).toEqual([
      'cortext/AgentRule.category',
      'cortext/Todo.status'
    ]);
  });
});

describe('tallyOffenders', () => {
  it('counts out-of-vocab values, most frequent first', () => {
    const out = tallyOffenders(['git', 'verification', 'verification', 'permissions'], ['git']);
    expect(out).toEqual([
      { value: 'verification', count: 2 },
      { value: 'permissions', count: 1 }
    ]);
  });

  it('does NOT flag null or undefined — a nullable enum legitimately holds them', () => {
    // assertEnumValues skips null/undefined on write for exactly this reason;
    // reporting them here would contradict the writer and bury real offenders.
    expect(tallyOffenders([null, undefined, 'git'], ['git'])).toEqual([]);
  });
});

describe('non-strict vocabularies', () => {
  const fed = {
    cortext: {
      types: {
        Decision: {
          fields: {
            status: {
              kind: 'scalar',
              type: 'string',
              enum: ['open', 'active'],
              aliases: { accepted: 'active' },
              strict: false
            }
          }
        }
      }
    }
  };

  it('carries aliases and strictness onto the collected field', () => {
    const [f] = collectEnumFields(fed);
    expect(f).toMatchObject({ aliases: { accepted: 'active' }, strict: false });
  });

  it('a non-strict field reports only stored aliases, not admitted free values', () => {
    const out = tallyOffenders(
      ['active', 'accepted', 'accepted', 'experimental', 'Active'],
      ['open', 'active'],
      {
        aliases: { accepted: 'active' },
        strict: false
      }
    );
    expect(out).toEqual([
      { value: 'accepted', count: 2 },
      { value: 'Active', count: 1 }
    ]);
  });

  it('a strict field still reports every out-of-vocab value', () => {
    const out = tallyOffenders(['accepted', 'experimental'], ['active'], {
      aliases: { accepted: 'active' }
    });
    expect(out.map((o) => o.value)).toEqual(['accepted', 'experimental']);
  });

  it('vocabHash moves when aliases change, and is unchanged for a plain enum', () => {
    expect(vocabHash(['a'])).toBe(vocabHash(['a'], {}));
    expect(vocabHash(['a'], { aliases: { b: 'a' } })).not.toBe(vocabHash(['a']));
  });
});

describe('runCheckEnums', () => {
  it('signs the schema fetch and every scan with SUBSTRATE_ENUM_CHECK_TOKEN', async () => {
    // Schema discovery and /substrate/v1/query both need a key once auth is on.
    const { fetchImpl: inner } = harness({ 'cortext/Todo': [{ status: 'open' }] });
    const seen: Array<string | null> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const authz = new Headers(init?.headers).get('authorization');
      seen.push(authz);
      if (authz === null) return new Response('{"code":"unauthorized"}', { status: 401 });
      return inner(url, init);
    };
    const sink = capture();
    const code = await runCheckEnums([], {
      baseUrl: 'https://h',
      fetchImpl,
      token: 'tok',
      write: sink.write
    });

    expect(code).toBe(0);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((a) => a === 'Bearer tok')).toBe(true);
  });

  it('refuses to send its token to plain http on a non-loopback host', async () => {
    let calls = 0;
    const sink = capture();
    const code = await runCheckEnums([], {
      baseUrl: 'http://h',
      fetchImpl: async () => {
        calls++;
        return new Response('{}');
      },
      token: 'tok',
      write: sink.write
    });
    expect(code).toBe(2);
    expect(calls).toBe(0);
  });

  it('names the missing token when the schema fetch is refused', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"code":"unauthorized"}', { status: 401 });
    const sink = capture();
    const code = await runCheckEnums([], { baseUrl: 'http://h', fetchImpl, write: sink.write });

    expect(code).toBe(2);
    expect(sink.out).toContain('SUBSTRATE_ENUM_CHECK_TOKEN');
  });

  it('exits 0 and says so when every stored value is in vocabulary', async () => {
    const { fetchImpl } = harness({
      'cortext/AgentRule': [{ category: 'git' }, { category: 'tooling' }],
      'cortext/Todo': [{ status: 'open' }]
    });
    const sink = capture();
    const code = await runCheckEnums([], { baseUrl: 'http://h', fetchImpl, write: sink.write });

    expect(code).toBe(0);
    expect(sink.out).toContain('No drift found.');
    expect(sink.out).toContain('Checked 2 enum-declared field(s).');
  });

  it('exits 1 and names the offending values and counts', async () => {
    const { fetchImpl } = harness({
      'cortext/AgentRule': [
        { category: 'git' },
        { category: 'verification' },
        { category: 'verification' },
        { category: 'permissions' }
      ],
      'cortext/Todo': [{ status: 'open' }]
    });
    const sink = capture();
    const code = await runCheckEnums([], { baseUrl: 'http://h', fetchImpl, write: sink.write });

    // Exit code is the load-bearing part — it is what makes this usable as a
    // gate rather than something a human has to read and remember to act on.
    expect(code).toBe(1);
    expect(sink.out).toContain('cortext/AgentRule.category');
    expect(sink.out).toContain("'verification' x2");
    expect(sink.out).toContain("'permissions' x1");
    // The clean field must not be reported as drifted.
    expect(sink.out).not.toContain('cortext/Todo.status');
  });

  it('follows pagination rather than judging the table by its first page', async () => {
    // The offender sits on page 3. A scan that stops at one page returns a
    // false clean — the single most likely way this command lies.
    const rows = Array.from({ length: 25 }, () => ({ category: 'git' }));
    rows[22] = { category: 'smuggled' };
    const { fetchImpl } = harness({ 'cortext/AgentRule': rows, 'cortext/Todo': [] }, 10);
    const sink = capture();
    const code = await runCheckEnums([], {
      baseUrl: 'http://h',
      fetchImpl,
      pageSize: 10,
      write: sink.write
    });

    expect(code).toBe(1);
    expect(sink.out).toContain("'smuggled' x1");
  });

  it('reports a truncated scan as PARTIAL, never as clean', async () => {
    // Silence must not read as health: stopping early means the offender may
    // sit past the cut, which is a different claim from "there is none".
    const rows = Array.from({ length: 40 }, () => ({ category: 'git' }));
    const { fetchImpl } = harness({ 'cortext/AgentRule': rows, 'cortext/Todo': [] }, 10);
    const sink = capture();
    const code = await runCheckEnums([], {
      baseUrl: 'http://h',
      fetchImpl,
      pageSize: 10,
      maxRows: 20,
      write: sink.write
    });

    expect(code).toBe(0);
    expect(sink.out).toContain('PARTIAL');
    expect(sink.out).toContain('table not exhausted');
  });

  it('surfaces an envelope error instead of scoring the field clean', async () => {
    const fetchImpl = async (url: string): Promise<Response> =>
      url.endsWith('/substrate/v1/federated-schema')
        ? new Response(JSON.stringify(FEDERATED), { status: 200 })
        : new Response(
            JSON.stringify({ data: {}, errors: [{ code: 'policy_denied', message: 'nope' }] }),
            { status: 200 }
          );

    await expect(
      runCheckEnums([], { baseUrl: 'http://h', fetchImpl, write: () => {} })
    ).rejects.toThrow(/policy_denied/);
  });

  it('refuses without a base URL rather than guessing one', async () => {
    const sink = capture();
    const code = await runCheckEnums([], {
      baseUrl: '',
      fetchImpl: async () => new Response('{}'),
      write: sink.write
    });
    expect(code).toBe(2);
    expect(sink.out).toContain('SUBSTRATE_URL is required');
  });

  it('--json emits the machine-readable report and keeps the exit code', async () => {
    const { fetchImpl } = harness({
      'cortext/AgentRule': [{ category: 'verification' }],
      'cortext/Todo': []
    });
    const sink = capture();
    const code = await runCheckEnums(['--json'], {
      baseUrl: 'http://h',
      fetchImpl,
      write: sink.write
    });

    expect(code).toBe(1);
    const parsed = JSON.parse(sink.out) as {
      fieldsChecked: number;
      drifted: Array<{ field: string; offenders: Array<{ value: string }> }>;
    };
    expect(parsed.fieldsChecked).toBe(2);
    expect(parsed.drifted).toHaveLength(1);
    expect(parsed.drifted[0]?.offenders[0]?.value).toBe('verification');
  });
});

describe('recordVerdicts', () => {
  it('vocabHash is stable and verdictId is the upsert key', async () => {
    const { vocabHash, verdictId } = await import('../src/cli/check-enums/main.js');
    expect(vocabHash(['a', 'b'])).toBe(vocabHash(['a', 'b']));
    expect(vocabHash(['a', 'b'])).not.toBe(vocabHash(['a', 'c']));
    expect(
      verdictId({
        namespace: 'c',
        type: 'T',
        field: 'f',
        vocabulary: [],
        rowsScanned: 0,
        offenders: [],
        truncated: false
      })
    ).toBe('c/T/f');
  });

  it('upserts per field: create when absent — drift still records with its outlier count', async () => {
    const { recordVerdicts, vocabHash } = await import('../src/cli/check-enums/main.js');
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (url.endsWith('/substrate/v1/query')) {
        return new Response(JSON.stringify({ data: { '_system/EnumCheckVerdict': [] } }), {
          status: 200
        });
      }
      return new Response(
        JSON.stringify({ data: { '_system/createEnumCheckVerdict': [{ id: 'x' }] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const code = await recordVerdicts(
      'https://h',
      fetchImpl,
      [
        {
          namespace: 'cortext',
          type: 'Todo',
          field: 'status',
          vocabulary: ['open', 'done'],
          rowsScanned: 3,
          offenders: [{ value: 'weird', count: 2 }],
          truncated: false
        }
      ],
      { token: 't', now: () => '2026-09-11T00:00:00.000Z' }
    );
    expect(code).toBe(0);
    const mutate = calls.find((c) => c.url.endsWith('/substrate/v1/mutate'));
    const frame = (mutate!.body as Record<string, { params: Record<string, unknown> }>)[
      '_system/createEnumCheckVerdict'
    ];
    expect(frame?.params).toMatchObject({
      id: 'cortext/Todo/status',
      vocabHash: vocabHash(['open', 'done']),
      checkedAt: '2026-09-11T00:00:00.000Z',
      rowsScanned: 3,
      outlierCount: 2,
      truncated: false
    });
  });

  it('updates when the verdict row already exists', async () => {
    const { recordVerdicts } = await import('../src/cli/check-enums/main.js');
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (url.endsWith('/substrate/v1/query')) {
        return new Response(
          JSON.stringify({ data: { '_system/EnumCheckVerdict': [{ id: 'cortext/Todo/status' }] } }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ data: { '_system/updateEnumCheckVerdict': [{ id: 'x' }] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const code = await recordVerdicts(
      'https://h',
      fetchImpl,
      [
        {
          namespace: 'cortext',
          type: 'Todo',
          field: 'status',
          vocabulary: ['open'],
          rowsScanned: 1,
          offenders: [],
          truncated: false
        }
      ],
      { token: 't' }
    );
    expect(code).toBe(0);
    expect(
      calls.some((c) => '_system/updateEnumCheckVerdict' in (c.body as Record<string, unknown>))
    ).toBe(true);
  });

  it('refuses without a credential — exit 3, never anonymous', async () => {
    const { recordVerdicts } = await import('../src/cli/check-enums/main.js');
    const fetchImpl = (async () => {
      throw new Error('must not reach the network without a token');
    }) as unknown as typeof fetch;
    const err: Array<string> = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      err.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await recordVerdicts('https://h', fetchImpl, [], { token: '' });
      expect(code).toBe(3);
      expect(err.join('')).toContain('SUBSTRATE_ENUM_CHECK_TOKEN');
    } finally {
      process.stderr.write = orig;
    }
  });
});
