import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { AdminBackfillError, AuthError, NetworkError, SubstrateClient } from '../src/index.js';
import { mockHandlers } from './_setup.js';

const E = 'http://substrate.test';
const client = () => new SubstrateClient({ endpoint: E, token: 't' });
const bodyOf = async (r: Request) => (await r.json()) as Record<string, unknown>;

describe('client.admin.dropNamespace / dropType', () => {
  it('POSTs drop-namespace with confirm, cascade and dryRun, and returns the counts', async () => {
    let sent: Record<string, unknown> = {};
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/drop-namespace`, async ({ request }) => {
        sent = await bodyOf(request);
        return HttpResponse.json({
          namespace: 'scratch',
          dryRun: true,
          cascade: 'delete',
          rowsDeleted: 7,
          edgesDeleted: 2,
          shortIdsDeleted: 7,
          auditEventId: 'a0'
        });
      })
    );
    const r = await client().admin.dropNamespace({
      namespace: 'scratch',
      confirm: 'scratch',
      cascade: 'delete',
      dryRun: true
    });
    expect(sent).toEqual({
      namespace: 'scratch',
      confirm: 'scratch',
      cascade: 'delete',
      dryRun: true
    });
    expect(r).toMatchObject({ rowsDeleted: 7, edgesDeleted: 2, dryRun: true });
  });

  it('omits cascade and dryRun when not given', async () => {
    let sent: Record<string, unknown> = {};
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/drop-type`, async ({ request }) => {
        sent = await bodyOf(request);
        return HttpResponse.json({
          namespace: 'n',
          type: 'T',
          dryRun: false,
          cascade: 'refuse',
          rowsDeleted: 1,
          edgesDeleted: 0,
          shortIdsDeleted: 1,
          auditEventId: 'a1'
        });
      })
    );
    await client().admin.dropType({ namespace: 'n', type: 'T', confirm: 'n/T' });
    expect(sent).toEqual({ namespace: 'n', type: 'T', confirm: 'n/T' });
  });

  it('a 409 dangling_edges keeps edgeCount and the sample edges', async () => {
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/drop-namespace`, () =>
        HttpResponse.json(
          { code: 'dangling_edges', message: 'm', edgeCount: 3, sampleEdges: [{ id: 'e1' }] },
          { status: 409 }
        )
      )
    );
    const err = (await client()
      .admin.dropNamespace({ namespace: 'n', confirm: 'n', dryRun: true })
      .catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.code).toBe('dangling_edges');
    expect(err.body).toMatchObject({ edgeCount: 3 });
  });

  it('a 403 destructive_ops_disabled is a coded AuthError', async () => {
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/drop-type`, () =>
        HttpResponse.json({ code: 'destructive_ops_disabled', message: 'm' }, { status: 403 })
      )
    );
    const err = await client()
      .admin.dropType({ namespace: 'n', type: 'T', confirm: 'n/T', dryRun: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('destructive_ops_disabled');
  });
});

describe('client.admin.normalise', () => {
  it('dry-runs by default and returns plan, unmapped and truncated', async () => {
    let sent: Record<string, unknown> = {};
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/normalise-vocab`, async ({ request }) => {
        sent = await bodyOf(request);
        return HttpResponse.json({
          namespace: 'cortext',
          type: 'Todo',
          field: 'status',
          strict: true,
          scanned: 50000,
          truncated: true,
          plan: [{ from: 'done', to: 'closed', count: 4 }],
          unmapped: [{ value: 'zombie', count: 1 }],
          applied: false
        });
      })
    );
    const r = await client().admin.normalise({
      namespace: 'cortext',
      type: 'Todo',
      field: 'status'
    });
    expect(sent).toEqual({ namespace: 'cortext', type: 'Todo', field: 'status' });
    expect(r.truncated).toBe(true);
    expect(r.unmapped).toEqual([{ value: 'zombie', count: 1 }]);
  });

  it('sends reject and apply when given', async () => {
    let sent: Record<string, unknown> = {};
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/normalise-vocab`, async ({ request }) => {
        sent = await bodyOf(request);
        return HttpResponse.json({
          namespace: 'n',
          type: 'T',
          field: 'f',
          strict: true,
          scanned: 1,
          truncated: false,
          plan: [],
          unmapped: [],
          applied: true,
          migrated: [],
          stranded: []
        });
      })
    );
    await client().admin.normalise({
      namespace: 'n',
      type: 'T',
      field: 'f',
      reject: ['a', 'b'],
      apply: true
    });
    expect(sent).toEqual({
      namespace: 'n',
      type: 'T',
      field: 'f',
      reject: ['a', 'b'],
      apply: true
    });
  });
});

describe('client.admin.backfill', () => {
  const values = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, 'x']));
  const ok = (n: number) => ({
    write: n,
    kept: 0,
    unchanged: 0,
    missing: [],
    counts: { x: n },
    applied: false
  });

  it('sends one dry-run request under the limit and returns the summary', async () => {
    const sent: Record<string, unknown>[] = [];
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/backfill-field`, async ({ request }) => {
        const b = await bodyOf(request);
        sent.push(b);
        return HttpResponse.json(ok(Object.keys(b.values as object).length));
      })
    );
    const r = await client().admin.backfill({
      namespace: 'n',
      type: 'T',
      field: 'f',
      values: values(3)
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ apply: false, overwrite: false });
    expect(r).toMatchObject({
      requested: 3,
      write: 3,
      chunks: 1,
      applied: false,
      counts: { x: 3 }
    });
  });

  it('chunks at BACKFILL_CHUNK, sums, and reports each chunk', async () => {
    const sizes: number[] = [];
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/backfill-field`, async ({ request }) => {
        const n = Object.keys((await bodyOf(request)).values as object).length;
        sizes.push(n);
        return HttpResponse.json({ ...ok(n), missing: [`m${sizes.length}`] });
      })
    );
    const seen: number[] = [];
    const r = await client().admin.backfill(
      { namespace: 'n', type: 'T', field: 'f', values: values(5001) },
      { onChunk: (c) => seen.push(c.index) }
    );
    expect(sizes).toEqual([5000, 1]);
    expect(seen).toEqual([0, 1]);
    expect(r).toMatchObject({ requested: 5001, write: 5001, chunks: 2, missing: ['m1', 'm2'] });
  });

  it('a refused second chunk throws AdminBackfillError naming what was already written', async () => {
    let call = 0;
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/backfill-field`, () => {
        call += 1;
        return call === 1
          ? HttpResponse.json({ ...ok(5000), applied: true })
          : HttpResponse.json(
              {
                code: 'invalid_values',
                message: 'm',
                invalid: [{ id: 'r5000', value: 1, reason: 'type' }]
              },
              { status: 400 }
            );
      })
    );
    const err = (await client()
      .admin.backfill({
        namespace: 'n',
        type: 'T',
        field: 'f',
        values: values(5001),
        apply: true
      })
      .catch((e: unknown) => e)) as AdminBackfillError;
    expect(err).toBeInstanceOf(AdminBackfillError);
    expect(err.chunksDone).toBe(1);
    expect(err.chunks).toBe(2);
    expect(err.partial).toMatchObject({ write: 5000, applied: true });
    expect((err.cause as NetworkError).body).toMatchObject({ invalid: [{ id: 'r5000' }] });
  });

  it('partial.applied says whether anything was written, not what was requested', async () => {
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/backfill-field`, () =>
        HttpResponse.json({ code: 'invalid_values', message: 'm' }, { status: 400 })
      )
    );
    const err = (await client()
      .admin.backfill({ namespace: 'n', type: 'T', field: 'f', values: values(3), apply: true })
      .catch((e: unknown) => e)) as AdminBackfillError;
    expect(err).toBeInstanceOf(AdminBackfillError);
    expect(err.chunksDone).toBe(0);
    expect(err.partial.applied).toBe(false);
  });

  it('a dry run that stops after a chunk reports partial.applied false', async () => {
    let call = 0;
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/backfill-field`, () => {
        call += 1;
        return call === 1
          ? HttpResponse.json(ok(5000))
          : HttpResponse.json({ code: 'invalid_values', message: 'm' }, { status: 400 });
      })
    );
    const err = (await client()
      .admin.backfill({ namespace: 'n', type: 'T', field: 'f', values: values(5001) })
      .catch((e: unknown) => e)) as AdminBackfillError;
    expect(err.chunksDone).toBe(1);
    expect(err.partial.applied).toBe(false);
  });

  it('an empty values object sends nothing and reports zero', async () => {
    let calls = 0;
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/backfill-field`, () => {
        calls += 1;
        return HttpResponse.json(ok(0));
      })
    );
    const r = await client().admin.backfill({ namespace: 'n', type: 'T', field: 'f', values: {} });
    expect(calls).toBe(0);
    expect(r).toMatchObject({ requested: 0, write: 0, chunks: 0 });
  });
});

describe('client.admin.reindexPage / embedStats', () => {
  it('POSTs one reindex page with cursor and limit', async () => {
    let sent: Record<string, unknown> = {};
    mockHandlers(
      http.post(`${E}/substrate/v1/embed/reindex`, async ({ request }) => {
        sent = await bodyOf(request);
        return HttpResponse.json({
          namespace: 'cortext',
          type: 'Memory',
          scanned: 100,
          embedded: 98,
          unindexable: 1,
          failed: 1,
          failures: [{ id: 'm1', error: 'e' }],
          hasMore: true,
          nextCursor: 'c2'
        });
      })
    );
    const p = await client().admin.reindexPage({
      namespace: 'cortext',
      type: 'Memory',
      cursor: 'c1',
      limit: 100
    });
    expect(sent).toEqual({ namespace: 'cortext', type: 'Memory', cursor: 'c1', limit: 100 });
    expect(p).toMatchObject({ embedded: 98, hasMore: true, nextCursor: 'c2' });
  });

  it('a 503 unavailable surfaces its nested code', async () => {
    mockHandlers(
      http.post(`${E}/substrate/v1/embed/reindex`, () =>
        HttpResponse.json(
          { error: { code: 'unavailable', message: 'embedder down' } },
          { status: 503 }
        )
      )
    );
    const err = (await client()
      .admin.reindexPage({ namespace: 'n', type: 'T' })
      .catch((e: unknown) => e)) as NetworkError;
    expect(err.status).toBe(503);
    expect(err.code).toBe('unavailable');
  });

  it('GETs embed-stats and keeps an absent embeddedTypes absent', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/embed-stats`, () => HttpResponse.json({ enabled: false }))
    );
    const s = await client().admin.embedStats();
    expect(s.enabled).toBe(false);
    expect('embeddedTypes' in s).toBe(false);
  });
});
