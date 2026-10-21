import { AdminBackfillError, AuthError, NetworkError } from '@mnmal-ai/substrate/client';
import { describe, expect, it } from 'vitest';
import { type PreviewClient, previewOf } from '../src/surgery/preview.js';

const env = (files: Record<string, string> = {}) => ({
  home: '/home/op',
  readFile: (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p] as string;
  }
});
const fake = (over: Partial<PreviewClient>): PreviewClient => ({
  dropNamespace: async () => {
    throw new Error('unexpected');
  },
  dropType: async () => {
    throw new Error('unexpected');
  },
  backfill: async () => {
    throw new Error('unexpected');
  },
  normalise: async () => {
    throw new Error('unexpected');
  },
  embedStats: async () => {
    throw new Error('unexpected');
  },
  ...over
});
const text = (p: { lines: readonly { text: string }[] }) => p.lines.map((l) => l.text).join('\n');

describe('drop previews', () => {
  it('dry-runs with confirm = target and shows the server counts', async () => {
    let sent: unknown;
    const p = await previewOf(
      { kind: 'drop-namespace', namespace: 'scratch', cascade: true },
      fake({
        dropNamespace: async (i) => {
          sent = i;
          return {
            namespace: 'scratch',
            dryRun: true,
            cascade: 'delete',
            rowsDeleted: 7,
            edgesDeleted: 2,
            shortIdsDeleted: 7,
            auditEventId: 'a0'
          };
        }
      }),
      env()
    );
    expect(sent).toEqual({
      namespace: 'scratch',
      confirm: 'scratch',
      cascade: 'delete',
      dryRun: true
    });
    expect(p.kind).toBe('ready');
    expect(text(p)).toContain('would delete 7 rows · 2 edges · 7 shortIds');
  });
  it('dangling_edges refuses in the preview with the count and samples', async () => {
    const p = await previewOf(
      { kind: 'drop-type', namespace: 'n', type: 'T', cascade: false },
      fake({
        dropType: async () => {
          throw new NetworkError('409', null, {
            status: 409,
            code: 'dangling_edges',
            serverMessage: 'm',
            body: { edgeCount: 3, sampleEdges: [{ id: 'e1' }, { id: 'e2' }] }
          });
        }
      }),
      env()
    );
    expect(p.kind).toBe('refused');
    expect(text(p)).toContain('3 dangling edges — pass --cascade');
    expect(text(p)).toContain('e1');
  });
  it('destructive_ops_disabled refuses in the preview', async () => {
    const p = await previewOf(
      { kind: 'drop-namespace', namespace: 'n', cascade: false },
      fake({
        dropNamespace: async () => {
          throw new AuthError('Forbidden', 403, {
            code: 'destructive_ops_disabled',
            serverMessage: 'm'
          });
        }
      }),
      env()
    );
    expect(p).toMatchObject({ kind: 'refused', refusal: { code: 'destructive_ops_disabled' } });
    expect(text(p)).toContain(
      'this deployment refuses destructive operations (SUBSTRATE_HARD_DELETE=refuse)'
    );
  });
  it('dangling_edges shows at most 5 sample edges', async () => {
    const p = await previewOf(
      { kind: 'drop-type', namespace: 'n', type: 'T', cascade: false },
      fake({
        dropType: async () => {
          throw new NetworkError('409', null, {
            status: 409,
            code: 'dangling_edges',
            serverMessage: 'm',
            body: {
              edgeCount: 7,
              sampleEdges: Array.from({ length: 7 }, (_, i) => ({ id: `edge-${i}` }))
            }
          });
        }
      }),
      env()
    );
    expect(text(p)).toContain('7 dangling edges');
    expect(text(p)).toContain('edge-4');
    expect(text(p)).not.toContain('edge-5');
  });
});

describe('previews never write: the exact requests', () => {
  const dropResult = {
    namespace: 'n',
    type: 'T',
    dryRun: true,
    cascade: 'refuse' as const,
    rowsDeleted: 0,
    edgesDeleted: 0,
    shortIdsDeleted: 0,
    auditEventId: 'a0'
  };
  it('drop-type dry-runs with confirm n/T and cascade refuse', async () => {
    let sent: unknown;
    await previewOf(
      { kind: 'drop-type', namespace: 'n', type: 'T', cascade: false },
      fake({
        dropType: async (i) => {
          sent = i;
          return dropResult;
        }
      }),
      env()
    );
    expect(sent).toEqual({
      namespace: 'n',
      type: 'T',
      confirm: 'n/T',
      cascade: 'refuse',
      dryRun: true
    });
  });
  it('drop-type --cascade dry-runs with cascade delete', async () => {
    let sent: unknown;
    await previewOf(
      { kind: 'drop-type', namespace: 'n', type: 'T', cascade: true },
      fake({
        dropType: async (i) => {
          sent = i;
          return { ...dropResult, cascade: 'delete' };
        }
      }),
      env()
    );
    expect(sent).toEqual({
      namespace: 'n',
      type: 'T',
      confirm: 'n/T',
      cascade: 'delete',
      dryRun: true
    });
  });
  it('normalise sends the reject list and never apply', async () => {
    let sent: unknown;
    await previewOf(
      { kind: 'normalise', namespace: 'n', type: 'T', field: 'f', reject: ['zombie'] },
      fake({
        normalise: async (i) => {
          sent = i;
          return {
            namespace: 'n',
            type: 'T',
            field: 'f',
            strict: false,
            scanned: 0,
            truncated: false,
            applied: false,
            plan: [],
            unmapped: []
          };
        }
      }),
      env()
    );
    expect(sent).toEqual({ namespace: 'n', type: 'T', field: 'f', reject: ['zombie'] });
    expect(sent).not.toHaveProperty('apply');
  });
});

describe('a rejected admin key is not a preview refusal', () => {
  it('a 401 on a drop dry run is rethrown, so admin.run can lock', async () => {
    await expect(
      previewOf(
        { kind: 'drop-namespace', namespace: 'n', cascade: false },
        fake({
          dropNamespace: async () => {
            throw new AuthError('Unauthorised', 401);
          }
        }),
        env()
      )
    ).rejects.toBeInstanceOf(AuthError);
  });
  it('the auth gate 403 (code forbidden) is rethrown', async () => {
    await expect(
      previewOf(
        { kind: 'reindex', targets: [] },
        fake({
          embedStats: async () => {
            throw new AuthError('Forbidden', 403, { code: 'forbidden' });
          }
        }),
        env()
      )
    ).rejects.toBeInstanceOf(AuthError);
  });
  it('a backfill dry run whose AdminBackfillError wraps a 401 is rethrown', async () => {
    const partial = {
      requested: 2,
      write: 0,
      kept: 0,
      unchanged: 0,
      missing: [],
      counts: {},
      applied: false,
      chunks: 1
    };
    await expect(
      previewOf(
        {
          kind: 'backfill',
          namespace: 'n',
          type: 'T',
          field: 'f',
          valuesPath: '~/v.json',
          overwrite: false
        },
        fake({
          backfill: async () => {
            throw new AdminBackfillError(new AuthError('Unauthorised', 401), 0, 1, partial);
          }
        }),
        env({ '/home/op/v.json': '{"a":"x","b":"x"}' })
      )
    ).rejects.toBeInstanceOf(AdminBackfillError);
  });
});

describe('backfill preview', () => {
  const op = {
    kind: 'backfill',
    namespace: 'n',
    type: 'T',
    field: 'f',
    valuesPath: '~/v.json',
    overwrite: false
  } as const;
  it('reads the file under ~, dry-runs it, and shows the summed counts', async () => {
    let sent: unknown;
    const p = await previewOf(
      op,
      fake({
        backfill: async (i) => {
          sent = i;
          return {
            requested: 2,
            write: 2,
            kept: 0,
            unchanged: 0,
            missing: [],
            counts: { x: 2 },
            applied: false,
            chunks: 1
          };
        }
      }),
      env({ '/home/op/v.json': '{"a":"x","b":"x"}' })
    );
    expect(sent).toMatchObject({ values: { a: 'x', b: 'x' }, overwrite: false });
    expect(sent).not.toHaveProperty('apply', true);
    expect(p.lines[0]?.text).toBe('values: /home/op/v.json · 2 entries');
    expect(text(p)).toContain('2 requested · would write 2');
    expect(p).toMatchObject({
      kind: 'ready',
      apply: { kind: 'backfill', values: { a: 'x', b: 'x' } }
    });
  });
  const summary = {
    requested: 2,
    write: 2,
    kept: 0,
    unchanged: 0,
    missing: [] as string[],
    counts: {} as Record<string, number>,
    applied: false,
    chunks: 1
  };
  it('the values line shows a relative path as absolute', async () => {
    let read = '';
    const p = await previewOf(
      { ...op, valuesPath: 'v.json' },
      fake({ backfill: async () => summary }),
      {
        home: '/home/op',
        readFile: (f: string) => {
          read = f;
          return '{"a":1}';
        }
      }
    );
    expect(read).toBe('v.json');
    expect(p.lines[0]?.text).toMatch(/^values: \/.*\/v\.json · 1 entries$/);
  });
  it('the values line sanitises the resolved path', async () => {
    const p = await previewOf(
      { ...op, valuesPath: '~/v\u001b[31m.json' },
      fake({ backfill: async () => summary }),
      env({ '/home/op/v\u001b[31m.json': '{}' })
    );
    expect(p.lines[0]?.text).not.toContain('\u001b');
    expect(p.lines[0]?.text).toMatch(/^values: \/home\/op\/v.*\.json · 0 entries$/);
  });
  it('shows 8 counts and summarises the rest', async () => {
    const counts = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`v${i}`, 20 - i]));
    const p = await previewOf(
      op,
      fake({ backfill: async () => ({ ...summary, counts }) }),
      env({ '/home/op/v.json': '{}' })
    );
    expect(text(p)).toContain('v7 · 13');
    expect(text(p)).not.toContain('v8 · 12');
    expect(text(p)).toContain('… 3 more values');
  });
  it('kept values say how to replace them, and missing ids warn', async () => {
    const p = await previewOf(
      op,
      fake({ backfill: async () => ({ ...summary, kept: 3, missing: ['r1', 'r2'] }) }),
      env({ '/home/op/v.json': '{}' })
    );
    expect(p.lines).toContainEqual({ text: 'kept 3 existing (pass --overwrite to replace)' });
    expect(p.lines).toContainEqual({ text: 'missing 2 id(s)', tone: 'warn' });
  });
  it('a refused chunk shows at most 8 invalid entries', async () => {
    const cause = new NetworkError('400', null, {
      status: 400,
      code: 'invalid_values',
      serverMessage: 'm',
      body: {
        invalid: Array.from({ length: 10 }, (_, i) => ({
          id: `row${i}`,
          value: 'z',
          reason: 'enum'
        }))
      }
    });
    const p = await previewOf(
      op,
      fake({
        backfill: async () => {
          throw new AdminBackfillError(cause, 0, 1, summary);
        }
      }),
      env({ '/home/op/v.json': '{}' })
    );
    expect(text(p)).toContain('row7: z (enum)');
    expect(text(p)).not.toContain('row8');
  });
  it('more than one chunk warns that apply is not atomic', async () => {
    const p = await previewOf(
      op,
      fake({
        backfill: async () => ({
          requested: 5001,
          write: 5001,
          kept: 0,
          unchanged: 0,
          missing: [],
          counts: {},
          applied: false,
          chunks: 2
        })
      }),
      env({ '/home/op/v.json': '{}' })
    );
    expect(text(p)).toContain('apply is NOT atomic');
  });
  it.each([
    ['missing', {}, 'unreadable'],
    ['not JSON', { '/home/op/v.json': 'nope' }, 'not_json'],
    ['an array', { '/home/op/v.json': '[1]' }, 'not_an_object']
  ])('a values file that is %s refuses locally and sends nothing', async (_, files, code) => {
    let calls = 0;
    const p = await previewOf(
      op,
      fake({
        backfill: async () => {
          calls++;
          throw new Error('x');
        }
      }),
      env(files)
    );
    expect(p).toMatchObject({ kind: 'refused', refusal: { code } });
    expect(calls).toBe(0);
  });
  it('~user is refused, not expanded', async () => {
    const p = await previewOf({ ...op, valuesPath: '~bob/v.json' }, fake({}), env());
    expect(p).toMatchObject({ kind: 'refused', refusal: { code: 'bad_path' } });
  });
  it('a refused chunk shows the invalid values', async () => {
    const cause = new NetworkError('400', null, {
      status: 400,
      code: 'invalid_values',
      serverMessage: 'm',
      body: { invalid: [{ id: 'r1', value: 'z', reason: 'enum' }] }
    });
    const p = await previewOf(
      op,
      fake({
        backfill: async () => {
          throw new AdminBackfillError(cause, 0, 1, {
            requested: 1,
            write: 0,
            kept: 0,
            unchanged: 0,
            missing: [],
            counts: {},
            applied: false,
            chunks: 1
          });
        }
      }),
      env({ '/home/op/v.json': '{"r1":"z"}' })
    );
    expect(p.kind).toBe('refused');
    expect(text(p)).toContain('r1: z (enum)');
  });
});

describe('normalise preview', () => {
  const base = {
    namespace: 'n',
    type: 'T',
    field: 'f',
    strict: true,
    scanned: 10,
    truncated: false,
    applied: false
  };
  it('a strict field with unmapped values not in --reject is refused in the preview', async () => {
    const p = await previewOf(
      { kind: 'normalise', namespace: 'n', type: 'T', field: 'f', reject: [] },
      fake({
        normalise: async () => ({ ...base, plan: [], unmapped: [{ value: 'zombie', count: 2 }] })
      }),
      env()
    );
    expect(p).toMatchObject({ kind: 'refused', refusal: { code: 'unmapped_values' } });
    expect(text(p)).toContain('zombie');
  });
  it('listing them in --reject makes it ready', async () => {
    const p = await previewOf(
      { kind: 'normalise', namespace: 'n', type: 'T', field: 'f', reject: ['zombie'] },
      fake({
        normalise: async () => ({
          ...base,
          plan: [{ from: 'done', to: 'closed', count: 4 }],
          unmapped: [{ value: 'zombie', count: 2 }]
        })
      }),
      env()
    );
    expect(p.kind).toBe('ready');
    expect(text(p)).toContain('done → closed · 4');
  });
  it('a truncated scan says the counts are partial', async () => {
    const p = await previewOf(
      { kind: 'normalise', namespace: 'n', type: 'T', field: 'f', reject: [] },
      fake({
        normalise: async () => ({ ...base, truncated: true, plan: [], unmapped: [] })
      }),
      env()
    );
    expect(text(p)).toContain('counts are partial');
  });
});

describe('reindex preview', () => {
  const stats = {
    enabled: true,
    embeddedTypes: [
      { namespace: 'journal', type: 'Memory' },
      { namespace: 'journal', type: 'Decision' }
    ]
  };
  it('no targets: every embedded type, and it says counts are unknown', async () => {
    const p = await previewOf(
      { kind: 'reindex', targets: [] },
      fake({ embedStats: async () => stats }),
      env()
    );
    expect(p).toMatchObject({
      kind: 'ready',
      apply: { kind: 'reindex', types: stats.embeddedTypes }
    });
    expect(text(p)).toContain('row counts are not known until it runs');
  });
  it('a type that is not embedded is refused, listing the embedded set', async () => {
    const p = await previewOf(
      { kind: 'reindex', targets: [{ namespace: 'journal', type: 'Nope' }] },
      fake({ embedStats: async () => stats }),
      env()
    );
    expect(p).toMatchObject({ kind: 'refused', refusal: { code: 'not_embedded' } });
    expect(text(p)).toContain('journal/Memory');
  });
  it('a disabled embedder or an unreported set is refused', async () => {
    expect(
      await previewOf(
        { kind: 'reindex', targets: [] },
        fake({ embedStats: async () => ({ enabled: false }) }),
        env()
      )
    ).toMatchObject({ kind: 'refused', refusal: { code: 'embedder_disabled' } });
    expect(
      await previewOf(
        { kind: 'reindex', targets: [] },
        fake({ embedStats: async () => ({ enabled: true }) }),
        env()
      )
    ).toMatchObject({ kind: 'refused', refusal: { code: 'no_embedded_types' } });
  });
});
