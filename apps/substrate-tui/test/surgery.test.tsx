import {
  AdminBackfillError,
  AuthError,
  NetworkError,
  type SubstrateClient
} from '@mnmal-ai/substrate/client';
import { createApp, defineModule } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { surgeryModule } from '../src/surgery/module.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const ESC = '\u001B';
const type = async (app: { stdin: { write(s: string): void } }, ...keys: string[]) => {
  for (const k of keys) {
    app.stdin.write(k);
    await tick();
  }
};
const DROP = {
  namespace: 'scratch',
  dryRun: true,
  cascade: 'delete',
  rowsDeleted: 7,
  edgesDeleted: 2,
  shortIdsDeleted: 7,
  auditEventId: 'a0'
};

function surgeryApp(
  over: {
    dropRefusal?: { status: number; code: string; body: Record<string, unknown> };
    backfillError?: unknown;
    counts?: Record<string, number>;
    reindexPages?: number;
    holdEachPage?: boolean;
    /** Thrown by every dry run (drop, backfill): a preview the server refuses. */
    dryRunError?: unknown;
    /** Holds each drop/backfill/normalise APPLY call until `releasePage`. */
    holdApply?: boolean;
    /** Thrown by every drop/normalise APPLY call, after any hold. */
    applyError?: unknown;
    size?: [number, number];
  } = {}
) {
  const calls: unknown[][] = [];
  let reindexN = 0;
  const releases: Array<() => void> = [];
  const admin = createAdminSession({
    endpoint: 'http://h',
    idleMs: 60_000,
    makeClient: () =>
      ({
        admin: {
          dropNamespace: async (i: { dryRun?: boolean }) => {
            calls.push(['dropNamespace', i]);
            if (i.dryRun === true && over.dryRunError) throw over.dryRunError;
            if (i.dryRun !== true && over.holdApply)
              await new Promise<void>((r) => releases.push(r));
            if (i.dryRun !== true && over.applyError) throw over.applyError;
            if (over.dropRefusal)
              throw new NetworkError(String(over.dropRefusal.status), null, {
                status: over.dropRefusal.status,
                code: over.dropRefusal.code,
                serverMessage: 'm',
                body: over.dropRefusal.body
              });
            return { ...DROP, dryRun: i.dryRun === true };
          },
          dropType: async (i: unknown) => {
            calls.push(['dropType', i]);
            return { ...DROP, type: 'T' };
          },
          backfill: async (i: { apply?: boolean }) => {
            calls.push(['backfill', i]);
            if (i.apply !== true && over.dryRunError) throw over.dryRunError;
            if (i.apply === true && over.holdApply)
              await new Promise<void>((r) => releases.push(r));
            if (i.apply === true && over.backfillError) throw over.backfillError;
            const counts = over.counts ?? { x: 2 };
            const n = Object.values(counts).reduce((a, b) => a + b, 0);
            return {
              requested: n,
              write: n,
              kept: 0,
              unchanged: 0,
              missing: [],
              counts,
              applied: i.apply === true,
              chunks: 1
            };
          },
          normalise: async (i: { apply?: boolean }) => {
            calls.push(['normalise', i]);
            if (i.apply === true && over.holdApply)
              await new Promise<void>((r) => releases.push(r));
            if (i.apply === true && over.applyError) throw over.applyError;
            return {
              namespace: 'n',
              type: 'T',
              field: 'f',
              strict: false,
              scanned: 1,
              truncated: false,
              plan: [],
              unmapped: [],
              applied: false,
              migrated: [],
              stranded: []
            };
          },
          embedStats: async () => ({
            enabled: true,
            embeddedTypes: [{ namespace: 'journal', type: 'Memory' }]
          }),
          reindexPage: async (i: { cursor?: string }) => {
            reindexN++;
            calls.push(['reindexPage', i]);
            if (over.holdEachPage) await new Promise<void>((r) => releases.push(r));
            const more = reindexN < (over.reindexPages ?? 1);
            return {
              namespace: 'journal',
              type: 'Memory',
              scanned: 10,
              embedded: 10,
              unindexable: 0,
              failed: 0,
              failures: [],
              hasMore: more,
              ...(more ? { nextCursor: `c${reindexN}` } : {})
            };
          }
        },
        close: async () => {}
      }) as unknown as SubstrateClient
  });
  admin.unlock('b-admin@Box', () => 't');
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    federatedSchema: (async () => ({})) as unknown as TuiDeps['federatedSchema'],
    getJson: async () => ({}),
    ...noDash,
    ...noAdmin(),
    admin
  };
  const files: Record<string, string> = { '/home/op/v.json': '{"a":"x","b":"x"}' };
  const readFile = (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p] as string;
  };
  const [columns, rows] = over.size ?? [120, 40];
  // Another module's panel, to show what opening it does to a running reindex.
  const other = defineModule<{ other: null }>('test.other', {
    commands: [
      {
        name: 'other',
        summary: 'opens another panel',
        args: [],
        run: (_, ctx) => ctx.open('other', null)
      }
    ],
    panels: { other: { view: () => null } }
  });
  const { App } = createApp({
    theme: marathon,
    modules: [surgeryModule(deps, { readFile, home: '/home/op' }), other],
    band: true
  });
  const r = render(<App columns={columns} rows={rows} />);
  return {
    ...r,
    admin,
    calls,
    frame: () => r.lastFrame() ?? '',
    /** The transcript renders above the panel, so it is read from the frame. */
    printed: () => r.lastFrame() ?? '',
    reindexCalls: () => reindexN,
    releasePage: async () => {
      await tick(20);
      releases.shift()?.();
    }
  };
}

describe('surgery', () => {
  it('the surgery commands are unavailable while locked', async () => {
    const app = surgeryApp();
    app.admin.lock('test');
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain('admin is locked');
    expect(app.calls).toEqual([]);
  });

  it('drop-namespace previews the dry-run counts and applies only on the exact typed target', async () => {
    const app = surgeryApp();
    await type(app, ...'/drop-namespace scratch --cascade', ENTER);
    await tick(80);
    expect(app.frame()).toContain('would delete 7 rows · 2 edges · 7 shortIds');
    expect(app.calls).toEqual([
      [
        'dropNamespace',
        { namespace: 'scratch', confirm: 'scratch', cascade: 'delete', dryRun: true }
      ]
    ]);
    await type(app, ...'scratch ', ENTER); // trailing space: mismatch
    await tick(60);
    expect(app.frame()).toContain("doesn't match");
    await type(app, ...'Scratch', ENTER); // wrong case: mismatch
    await tick(60);
    expect(app.calls).toHaveLength(1);
    await type(app, ...'scratch', ENTER);
    await tick(80);
    expect(app.calls[1]).toEqual([
      'dropNamespace',
      { namespace: 'scratch', confirm: 'scratch', cascade: 'delete', dryRun: false }
    ]);
    expect(app.printed()).toMatch(
      /✓ dropped namespace scratch: 7 rows, 2 edges \(admin: b-admin@Box\)/
    );
  });

  it('the input line is not pre-filled with the target', async () => {
    const app = surgeryApp();
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).not.toMatch(/›\s*scratch\s*$/m);
  });

  it('a refused preview leaves apply dead', async () => {
    const app = surgeryApp({
      dropRefusal: { status: 409, code: 'dangling_edges', body: { edgeCount: 3, sampleEdges: [] } }
    });
    await type(app, ...'/drop-namespace n', ENTER);
    await tick(80);
    expect(app.frame()).toContain('apply is unavailable');
    await type(app, ...'n', ENTER);
    await tick(60);
    expect(app.calls).toHaveLength(1);
  });

  it('reindex shows progress per page and esc stops between pages', async () => {
    const app = surgeryApp({ reindexPages: 5, holdEachPage: true });
    await type(app, ...'/reindex journal/Memory', ENTER);
    await tick(80);
    await type(app, ...'reindex', ENTER);
    await app.releasePage();
    await tick(60);
    expect(app.frame()).toMatch(/journal\/Memory\s+scanned 10/);
    await type(app, ESC);
    await app.releasePage();
    await tick(80);
    expect(app.reindexCalls()).toBe(2);
    expect(app.frame()).toContain('stopped');
    expect(app.printed()).toMatch(/■ reindex stopped at journal\/Memory/);
  });

  it('a lock mid-reindex closes the panel and requests no further page', async () => {
    const app = surgeryApp({ reindexPages: 5, holdEachPage: true });
    await type(app, ...'/reindex', ENTER);
    await tick(80);
    await type(app, ...'reindex', ENTER);
    await app.releasePage();
    await tick(40);
    app.admin.lock('test');
    await app.releasePage();
    await tick(80);
    expect(app.frame()).not.toContain('surgery ›');
    expect(app.reindexCalls()).toBe(2);
    expect(app.printed()).toContain(
      'surgery closed — admin locked; the reindex requests no further page'
    );
    expect(app.printed()).toMatch(/■ reindex stopped at journal\/Memory \(cursor c2\)/);
  });

  it('a backfill apply refused on its second chunk says how many chunks were written', async () => {
    const cause = new NetworkError('400', null, {
      status: 400,
      code: 'invalid_values',
      serverMessage: 'bad',
      body: { invalid: [] }
    });
    const partial = {
      requested: 5001,
      write: 5000,
      kept: 0,
      unchanged: 0,
      missing: [],
      counts: {},
      applied: true,
      chunks: 2
    };
    const app = surgeryApp({ backfillError: new AdminBackfillError(cause, 1, 2, partial) });
    await type(app, ...'/backfill n/T.f --values ~/v.json', ENTER);
    await tick(80);
    await type(app, ...'n/T.f', ENTER);
    await tick(80);
    expect(app.frame()).toContain('invalid_values');
    expect(app.frame()).toContain('1 of 2 chunk(s) were written before the refusal');
    expect(app.calls.filter((c) => c[0] === 'backfill')).toHaveLength(2);
  });

  it('renders the whole preview within 80×26', async () => {
    const counts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`value-${i}`, i + 1]));
    const app = surgeryApp({ size: [80, 26], counts });
    await type(app, ...'/backfill n/T.f --values ~/v.json', ENTER);
    await tick(100);
    const lines = app.frame().split('\n');
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);
    expect(app.frame()).toContain('type n/T.f then enter to apply');
    expect(app.frame()).toContain('more values');
  });
  it('at 80×24 a preview too tall for the panel announces its cut, and keeps the apply line', async () => {
    const counts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`value-${i}`, i + 1]));
    const app = surgeryApp({ size: [80, 24], counts });
    await type(app, ...'/backfill n/T.f --values ~/v.json', ENTER);
    await tick(100);
    expect(app.frame()).toMatch(/… \d+ more/);
    expect(app.frame()).toContain('type n/T.f then enter to apply');
  });
  it('opening another panel mid-reindex stops it after its page and never writes the new panel', async () => {
    const app = surgeryApp({ reindexPages: 5, holdEachPage: true });
    await type(app, ...'/reindex', ENTER);
    await tick(80);
    await type(app, ...'reindex', ENTER);
    await tick(40);
    await type(app, ...'/other', ENTER);
    await tick(80);
    await app.releasePage();
    await tick(80);
    expect(app.reindexCalls()).toBe(1);
    expect(app.frame()).not.toContain('surgery ›');
    expect(app.frame()).not.toContain('scanned 10');
    expect(app.printed()).toMatch(/■ reindex stopped at journal\/Memory \(cursor c1\)/);
  });

  it('a surgery command mid-reindex is unavailable: one surgery write at a time', async () => {
    const app = surgeryApp({ reindexPages: 2, holdEachPage: true });
    await type(app, ...'/reindex', ENTER);
    await tick(80);
    await type(app, ...'reindex', ENTER);
    await tick(40);
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain('a surgery write is in progress — wait for it to report');
    expect(app.calls.filter((c) => c[0] === 'dropNamespace')).toHaveLength(0);
  });

  it('a second command during a backfill apply is refused, and available again once it settles', async () => {
    const app = surgeryApp({ holdApply: true });
    await type(app, ...'/backfill n/T.f --values ~/v.json', ENTER);
    await tick(80);
    await type(app, ...'n/T.f', ENTER);
    await tick(40);
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain(
      '/drop-namespace: a surgery write is in progress — wait for it to report'
    );
    expect(app.calls.filter((c) => c[0] === 'dropNamespace')).toHaveLength(0);
    await app.releasePage();
    await tick(80);
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.calls.filter((c) => c[0] === 'dropNamespace')).toHaveLength(1);
    expect(app.frame()).toContain('surgery › scratch · preview');
  });

  it('a write in flight when the lock closed the panel still holds surgery until it settles', async () => {
    const app = surgeryApp({ holdApply: true });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    await type(app, ...'scratch', ENTER);
    await tick(40);
    app.admin.lock('test');
    await tick(40);
    app.admin.unlock('b-admin@Box', () => 't');
    await type(app, ...'/normalise n/T.f', ENTER);
    await tick(80);
    expect(app.frame()).toContain('a surgery write is in progress');
    await app.releasePage();
    await tick(80);
    await type(app, ...'/normalise n/T.f', ENTER);
    await tick(80);
    expect(app.frame()).toContain('surgery › n/T.f · preview');
  });

  it('surgery commands are available again after a refused apply', async () => {
    const app = surgeryApp({
      applyError: new NetworkError('409', null, {
        status: 409,
        code: 'dangling_edges',
        serverMessage: 'm',
        body: { edgeCount: 1, sampleEdges: [] }
      })
    });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    await type(app, ...'scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain('surgery › scratch · refused');
    await type(app, ...'/normalise n/T.f', ENTER);
    await tick(80);
    expect(app.frame()).not.toContain('a surgery write is in progress');
    expect(app.frame()).toContain('surgery › n/T.f · preview');
  });

  it('surgery commands are available again after a reindex stopped by esc', async () => {
    const app = surgeryApp({ reindexPages: 5, holdEachPage: true });
    await type(app, ...'/reindex', ENTER);
    await tick(80);
    await type(app, ...'reindex', ENTER);
    await tick(40);
    await type(app, ESC);
    await app.releasePage();
    await tick(80);
    expect(app.frame()).toContain('surgery › reindex · stopped');
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).not.toContain('a surgery write is in progress');
    expect(app.frame()).toContain('surgery › scratch · preview');
  });

  it('the lock reason wins over the write-in-progress reason', async () => {
    const app = surgeryApp({ holdApply: true });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    await type(app, ...'scratch', ENTER);
    await tick(40);
    app.admin.lock('test');
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain('/drop-namespace: admin is locked');
    expect(app.frame()).not.toContain('a surgery write is in progress');
  });

  it('an apply refused with dangling_edges shows the edge count, as the preview would', async () => {
    const app = surgeryApp({
      applyError: new NetworkError('409', null, {
        status: 409,
        code: 'dangling_edges',
        serverMessage: 'edges point in',
        body: { edgeCount: 4, sampleEdges: [{ id: 'e9' }] }
      })
    });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    await type(app, ...'scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain('surgery › scratch · refused');
    expect(app.frame()).toContain('dangling_edges: edges point in');
    expect(app.frame()).toContain('4 dangling edges — pass --cascade to delete them');
    expect(app.frame()).toContain('e9');
  });

  it('a normalise apply failing with a 5xx says the server-side state is unknown, in panel and transcript', async () => {
    const app = surgeryApp({
      applyError: new NetworkError('503', null, {
        status: 503,
        code: 'unavailable',
        serverMessage: 'db down'
      })
    });
    await type(app, ...'/normalise n/T.f', ENTER);
    await tick(80);
    await type(app, ...'n/T.f', ENTER);
    await tick(80);
    const unknown = 'the server-side state is unknown — re-run the preview to see what changed';
    expect(app.frame()).toContain('surgery › n/T.f · refused');
    expect(app.frame().split(unknown)).toHaveLength(3); // the transcript and the panel
  });

  it('a normalise apply refused with a 4xx does not claim the state is unknown', async () => {
    const app = surgeryApp({
      applyError: new NetworkError('409', null, {
        status: 409,
        code: 'unmapped_values',
        serverMessage: 'no alias',
        body: { unmapped: [{ value: 'zombie', count: 2 }] }
      })
    });
    await type(app, ...'/normalise n/T.f', ENTER);
    await tick(80);
    await type(app, ...'n/T.f', ENTER);
    await tick(80);
    expect(app.frame()).toContain('unmapped_values: no alias');
    expect(app.frame()).toContain('zombie · 2');
    expect(app.frame()).not.toContain('server-side state is unknown');
  });

  it('a 401 on the drop dry run locks the session and closes the panel', async () => {
    const app = surgeryApp({ dryRunError: new AuthError('Unauthorised', 401) });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.admin.unlocked()).toBe(false);
    expect(app.frame()).not.toContain('surgery ›');
  });

  it('a backfill dry run whose AdminBackfillError wraps a 401 locks the session', async () => {
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
    const app = surgeryApp({
      dryRunError: new AdminBackfillError(new AuthError('Unauthorised', 401), 0, 1, partial)
    });
    await type(app, ...'/backfill n/T.f --values ~/v.json', ENTER);
    await tick(80);
    expect(app.admin.unlocked()).toBe(false);
    expect(app.frame()).not.toContain('surgery ›');
  });

  it('a coded 403 on the dry run stays a preview refusal and does not lock', async () => {
    const app = surgeryApp({
      dryRunError: new AuthError('Forbidden', 403, {
        code: 'destructive_ops_disabled',
        serverMessage: 'm'
      })
    });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.admin.unlocked()).toBe(true);
    expect(app.frame()).toContain('destructive_ops_disabled');
    expect(app.frame()).toContain('apply is unavailable');
  });

  it('a lock mid-backfill says the write finishes, and its result still reaches the transcript', async () => {
    const app = surgeryApp({ holdApply: true });
    await type(app, ...'/backfill n/T.f --values ~/v.json', ENTER);
    await tick(80);
    await type(app, ...'n/T.f', ENTER);
    await tick(40);
    app.admin.lock('test');
    await tick(40);
    expect(app.frame()).not.toContain('surgery ›');
    expect(app.printed()).toContain(
      'surgery closed — admin locked; the n/T.f backfill in flight reports its outcome below'
    );
    await app.releasePage();
    await tick(80);
    expect(app.printed()).toMatch(/✓ backfilled n\/T\.f: wrote 2 of 2 \(admin: b-admin@Box\)/);
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    expect(app.frame()).toContain('admin is locked');
    expect(app.calls.filter((c) => c[0] === 'dropNamespace')).toHaveLength(0);
  });

  it('esc during a single (non-reindex) apply keeps the panel open', async () => {
    const app = surgeryApp({ holdApply: true });
    await type(app, ...'/drop-namespace scratch', ENTER);
    await tick(80);
    await type(app, ...'scratch', ENTER);
    await type(app, ESC);
    await tick(40);
    expect(app.frame()).toContain('surgery › scratch · applying');
    await app.releasePage();
    await tick(80);
    expect(app.frame()).toContain('surgery › scratch · done');
  });
});
