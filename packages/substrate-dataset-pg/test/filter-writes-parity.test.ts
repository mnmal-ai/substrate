/**
 * `updateMany<T>` / `deleteMany<T>` through `Engine`, memory against pg: every
 * scenario answers the same on both. The caps are set low (`maxMatch` 5,
 * `idsCap` 3) so the bounds are reachable with a handful of rows.
 *
 * Each scenario gets a fresh namespace.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row as rowPolicy } from '@mnmal-ai/substrate-policy';
import { field, installAutoCrud } from '@mnmal-ai/substrate-sdk';
import type {
  CommittedWriteBatch,
  Dataset,
  EdgesStore,
  FieldDef,
  PackEnvelope,
  Policy,
  RequestContext
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, PgEdgesStore } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const PREFIX = 'fwrite';
const LIMITS = { maxMatch: 5, idsCap: 3 };
const RESULT_SEL = { count: true, ids: true, idsTruncated: true };

type Params = Record<string, unknown>;
type Kind = 'memory' | 'pg';

function fieldsFor(ns: string) {
  const owner: Record<string, FieldDef> = { id: field.string(), name: field.string() };
  const item: Record<string, FieldDef> = {
    id: field.string(),
    title: field.string(),
    status: field.enum(['open', 'closed']),
    owner: field.crossRef(ns, 'Owner', { onDelete: 'restrict' }),
    parent: field.crossRef(ns, 'Item')
  };
  return { owner, item };
}

function ctx(id = 'tester'): RequestContext {
  return {
    identity: { kind: 'agent', id, agentKeyId: id, grants: { '*': ['read', 'mutate'] } },
    namespace: 'any',
    operation: 'mutate',
    now: NOW,
    headers: {},
    meta: {}
  };
}

const items = (n: number, status = 'open'): Params[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${String(i).padStart(3, '0')}`,
    title: `item ${i}`,
    status,
    owner: `o${i % 3}`
  }));

describe('updateMany / deleteMany: memory vs pg through Engine', () => {
  let sql: Sql | undefined;
  let seq = 0;
  const run = Date.now().toString(36);

  beforeAll(() => {
    if (POSTGRES_URL === undefined) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql === undefined) return;
    const like = `${PREFIX}%`;
    await sql`DELETE FROM short_ids WHERE namespace LIKE ${like}`;
    await sql`DELETE FROM edges WHERE from_ns LIKE ${like} OR to_ns LIKE ${like}`;
    await sql`DELETE FROM rows WHERE namespace LIKE ${like}`;
    await sql.end();
  });

  async function stack(kind: Kind, ns: string, itemPolicy?: Policy) {
    let dataset: Dataset;
    let edges: EdgesStore;
    if (kind === 'pg') {
      const pgEdges = new PgEdgesStore({ sql: sql as Sql });
      const pg = new PgDataset({ namespace: ns, sql: sql as Sql, edgesStore: pgEdges });
      if (PARTITIONED) {
        await pg.ensureTypeStorage('Owner');
        await pg.ensureTypeStorage('Item');
      }
      dataset = pg;
      edges = pgEdges;
    } else {
      dataset = new MemoryDataset({ namespace: ns });
      edges = new MemoryEdgesStore({ now: () => NOW });
    }
    const { owner, item } = fieldsFor(ns);
    const registry = new Registry();
    installAutoCrud(registry, 'Owner', dataset, edges, { fields: owner });
    installAutoCrud(registry, 'Item', dataset, edges, {
      fields: item,
      ...(itemPolicy !== undefined ? { policy: itemPolicy } : {})
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(ns, dataset);
    const committed: CommittedWriteBatch[] = [];
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[ns, { registry }]]),
      datasets,
      edges,
      filterWriteLimits: LIMITS,
      committedWritesHooks: [{ plugin: 'probe', hook: (b) => void committed.push(b) }]
    });
    const mutate = (op: string, params: Params | Params[], as = 'tester') => {
      const fields = op.includes('Many') ? RESULT_SEL : { id: true };
      return engine.mutate({
        frame: {
          [`${ns}/${op}`]: Array.isArray(params)
            ? params.map((p) => ({ params: p, fields }))
            : { params, fields }
        },
        ctx: ctx(as)
      });
    };
    const query = (type: string, params: Params, as = 'tester') =>
      engine.query({
        frame: { [`${ns}/${type}`]: { params, fields: { id: true } } },
        ctx: { ...ctx(as), operation: 'query' }
      });
    /**
     * The envelope with the namespace taken out of keys and paths. Ids are left
     * in the order the server gave: ascending is the contract under test.
     */
    const strip = (env: PackEnvelope) => {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(env.data)) data[k.slice(ns.length + 1)] = v;
      const errors = (env.errors ?? []).map((e) => ({
        code: e.code,
        path: e.path?.map((p) => p.replace(`${ns}/`, ''))
      }));
      return { data, errors };
    };
    /** Every Item, live or not, as `id:title:status:live`, sorted. */
    const snapshot = async () =>
      (await dataset.read('Item', { includeDeleted: true })).rows
        .map(
          (r) => `${String(r.id)}:${String(r.title)}:${String(r.status)}:${r._deletedAt == null}`
        )
        .sort();
    const seed = async (rows: Params[]) => {
      const owners = await mutate('createOwner', [
        { id: 'o0', name: 'owner 0' },
        { id: 'o1', name: 'owner 1' },
        { id: 'o2', name: 'owner 2' }
      ]);
      expect(owners.errors).toBeUndefined();
      if (rows.length > 0) expect((await mutate('createItem', rows)).errors).toBeUndefined();
    };
    /** Live edges out of this namespace's Items, as `from>to:field`, sorted. */
    const liveEdges = async () => {
      const { edges: list } = await edges.readNextBatch(null, 100_000);
      return list
        .filter((e) => e.from.ns === ns && e.deletedAt == null)
        .map((e) => `${String(e.from.id)}>${e.to.type}:${String(e.to.id)}:${e.fieldName}`)
        .sort();
    };
    return {
      kind,
      ns,
      dataset,
      engine,
      committed,
      mutate,
      query,
      strip,
      snapshot,
      seed,
      liveEdges
    };
  }
  type Stack = Awaited<ReturnType<typeof stack>>;

  const fresh = () => `${PREFIX}_${run}_${++seq}`;

  /** Run `scenario` on memory, then on pg when POSTGRES_URL is set; both must agree. */
  async function onBoth(
    scenario: (s: Stack, other: (p?: Policy) => Promise<Stack>) => Promise<unknown>,
    policy?: Policy
  ): Promise<void> {
    const kinds: Kind[] = sql === undefined ? ['memory'] : ['memory', 'pg'];
    const results: unknown[] = [];
    for (const kind of kinds) {
      const s = await stack(kind, fresh(), policy);
      results.push(await scenario(s, (p) => stack(kind, fresh(), p)));
    }
    if (results.length === 2) expect(results[1]).toEqual(results[0]);
  }

  it('updateMany sets every match; result {count, ids, idsTruncated:false}', async () => {
    await onBoth(async (s) => {
      await s.seed([...items(3), { id: 'x', title: 'x', status: 'closed', owner: 'o0' }]);
      const env = s.strip(
        await s.mutate('updateManyItem', {
          where: { status: { eq: 'open' } },
          set: { title: 'renamed' }
        })
      );
      expect(env.errors).toEqual([]);
      expect(env.data.updateManyItem).toEqual({
        count: 3,
        ids: ['i000', 'i001', 'i002'],
        idsTruncated: false
      });
      const after = await s.snapshot();
      expect(after).toEqual([
        'i000:renamed:open:true',
        'i001:renamed:open:true',
        'i002:renamed:open:true',
        'x:x:closed:true'
      ]);
      return { env, after };
    });
  });

  it('ids capped at idsCap with idsTruncated:true; count exact', async () => {
    await onBoth(async (s) => {
      await s.seed(items(4));
      const env = await s.mutate('updateManyItem', {
        where: { status: { eq: 'open' } },
        set: { title: 'capped' }
      });
      expect(env.errors).toBeUndefined();
      const r = env.data[`${s.ns}/updateManyItem`] as {
        count: number;
        ids: string[];
        idsTruncated: boolean;
      };
      // The lowest idsCap ids, ascending, whatever order the store returned.
      expect(r).toEqual({ count: 4, ids: ['i000', 'i001', 'i002'], idsTruncated: true });
      return r;
    });
  });

  it('exactly maxMatch matches runs; maxMatch+1 refused filter_too_broad, store unchanged', async () => {
    await onBoth(async (s) => {
      await s.seed(items(LIMITS.maxMatch));
      const exact = s.strip(
        await s.mutate('updateManyItem', { where: { status: { eq: 'open' } }, set: { title: 'a' } })
      );
      expect(exact.errors).toEqual([]);
      expect(exact.data.updateManyItem).toEqual({
        count: LIMITS.maxMatch,
        ids: ['i000', 'i001', 'i002'],
        idsTruncated: true
      });

      expect(
        (await s.mutate('createItem', { id: 'extra', title: 'extra', status: 'open', owner: 'o0' }))
          .errors
      ).toBeUndefined();
      const before = await s.snapshot();
      const broad = s.strip(
        await s.mutate('updateManyItem', { where: { status: { eq: 'open' } }, set: { title: 'b' } })
      );
      expect(broad.errors).toEqual([{ code: 'filter_too_broad', path: ['updateManyItem'] }]);
      expect(await s.snapshot()).toEqual(before);
      const broadDelete = s.strip(
        await s.mutate('deleteManyItem', { where: { status: { eq: 'open' } } })
      );
      expect(broadDelete.errors).toEqual([{ code: 'filter_too_broad', path: ['deleteManyItem'] }]);
      expect(await s.snapshot()).toEqual(before);
      return { exact, broad, broadDelete, before };
    });
  });

  it('set changes the where field: each matched row once', async () => {
    await onBoth(async (s) => {
      await s.seed([
        ...items(LIMITS.idsCap),
        { id: 'z', title: 'z', status: 'closed', owner: 'o0' }
      ]);
      const env = s.strip(
        await s.mutate('updateManyItem', {
          where: { status: { eq: 'open' } },
          set: { status: 'closed' }
        })
      );
      expect(env.errors).toEqual([]);
      expect(env.data.updateManyItem).toEqual({
        count: 3,
        ids: ['i000', 'i001', 'i002'],
        idsTruncated: false
      });
      expect((await s.snapshot()).every((r) => r.includes(':closed:'))).toBe(true);
      return env;
    });
  });

  // Owner-style: bob reads only the items owned by o0 or o2; anyone else reads all.
  // The predicate reads a real field, so it would drop a result struct that lacks it.
  const bobsItems = rowPolicy((c, r) => {
    const owner = (r as { owner?: unknown }).owner;
    return c.identity?.id !== 'bob' || owner === 'o0' || owner === 'o2';
  });

  it('row-policy type: filtered form equals unfiltered form on rows the caller may see', async () => {
    await onBoth(async (byFilter, other) => {
      const byId = await other(bobsItems);
      // Owners o0, o1, o2, o0: bob cannot see i001.
      for (const s of [byFilter, byId]) await s.seed(items(4));

      // The filtered form: one updateMany as bob.
      const env = byFilter.strip(
        await byFilter.mutate(
          'updateManyItem',
          { where: { status: { eq: 'open' } }, set: { status: 'closed' } },
          'bob'
        )
      );
      expect(env.errors).toEqual([]);

      // The unfiltered form: bob reads what he may see, then updates each by id.
      const visible = (await byId.query('Item', { where: { status: { eq: 'open' } } }, 'bob')).data[
        `${byId.ns}/Item`
      ] as Array<{ id: string }>;
      expect(visible.map((v) => String(v.id)).sort()).toEqual(['i000', 'i002', 'i003']);
      for (const { id } of visible) {
        expect(
          (await byId.mutate('updateItem', { id, status: 'closed' }, 'bob')).errors
        ).toBeUndefined();
      }
      expect(env.data.updateManyItem).toEqual({
        count: 3,
        ids: ['i000', 'i002', 'i003'],
        idsTruncated: false
      });
      const after = await byFilter.snapshot();
      expect(after).toEqual(await byId.snapshot());
      expect(after).toContain('i001:item 1:open:true');
      return { env, after };
    }, bobsItems);
  });

  it('row-policy type: deleteMany as a row-filtered caller returns the whole result', async () => {
    await onBoth(async (s) => {
      await s.seed(items(4));
      const env = s.strip(
        await s.mutate('deleteManyItem', { where: { status: { eq: 'open' } } }, 'bob')
      );
      expect(env.errors).toEqual([]);
      expect(env.data.deleteManyItem).toEqual({
        count: 3,
        ids: ['i000', 'i002', 'i003'],
        idsTruncated: false
      });
      const after = await s.snapshot();
      expect(after).toEqual([
        'i000:item 0:open:false',
        'i001:item 1:open:true',
        'i002:item 2:open:false',
        'i003:item 3:open:false'
      ]);
      return { env, after };
    }, bobsItems);
  });

  it('deleteMany with a restrict inbound edge → restrict_violation, nothing tombstoned', async () => {
    await onBoth(async (s) => {
      await s.seed(items(1));
      const before = await s.snapshot();
      const owners = async () =>
        (await s.dataset.read('Owner', {})).rows.map((r) => String(r.id)).sort();
      const env = s.strip(
        await s.mutate('deleteManyOwner', { where: { name: { startsWith: 'owner' } } })
      );
      expect(env.errors.map((e) => e.code)).toEqual(['restrict_violation']);
      expect(await owners()).toEqual(['o0', 'o1', 'o2']);
      expect(await s.snapshot()).toEqual(before);
      // Without the blocking row, the same filter deletes all three.
      const freed = s.strip(
        await s.mutate('deleteManyOwner', { where: { name: { startsWith: 'owner 1' } } })
      );
      expect(freed.data.deleteManyOwner).toEqual({ count: 1, ids: ['o1'], idsTruncated: false });
      return { env, freed, owners: await owners() };
    });
  });

  it("a crossRef in set repoints every matched row's edge, as update<T> by id does; a missing target refuses", async () => {
    await onBoth(async (byFilter, other) => {
      const byId = await other();
      for (const s of [byFilter, byId]) await s.seed(items(3));
      const env = byFilter.strip(
        await byFilter.mutate('updateManyItem', {
          where: { owner: { in: ['o0', 'o1'] } },
          set: { owner: 'o2' }
        })
      );
      expect(env.errors).toEqual([]);
      for (const id of ['i000', 'i001']) {
        expect((await byId.mutate('updateItem', { id, owner: 'o2' })).errors).toBeUndefined();
      }
      const edgesAfter = await byFilter.liveEdges();
      expect(edgesAfter).toEqual(await byId.liveEdges());
      expect(edgesAfter).toEqual([
        'i000>Owner:o2:owner',
        'i001>Owner:o2:owner',
        'i002>Owner:o2:owner'
      ]);
      const missing = byFilter.strip(
        await byFilter.mutate('updateManyItem', {
          where: { owner: { eq: 'o2' } },
          set: { owner: 'nobody' }
        })
      );
      expect(missing.errors.map((e) => e.code)).toEqual(['missing_referent']);
      expect(await byFilter.liveEdges()).toEqual(edgesAfter);
      return { env, edgesAfter, missing };
    });
  });

  it("where with an unknown field → the query path's code", async () => {
    await onBoth(async (s) => {
      await s.seed(items(1));
      const where = { nope: { eq: 1 } };
      const q = s.strip(await s.query('Item', { where }));
      const m = s.strip(await s.mutate('updateManyItem', { where, set: { title: 'x' } }));
      const d = s.strip(await s.mutate('deleteManyItem', { where }));
      expect(q.errors).toHaveLength(1);
      expect(m.errors.map((e) => e.code)).toEqual(q.errors.map((e) => e.code));
      expect(d.errors.map((e) => e.code)).toEqual(q.errors.map((e) => e.code));
      expect(m.errors[0]?.path?.slice(1)).toEqual(q.errors[0]?.path?.slice(1));
      expect(await s.snapshot()).toEqual(['i000:item 0:open:true']);
      return { q, m, d };
    });
  });

  it('walk grammar in where → walks_in_mutation', async () => {
    await onBoth(async (s) => {
      await s.seed(items(1));
      const where = { owner: { _walk: { out: 'owner', where: { name: { eq: 'owner 0' } } } } };
      const m = s.strip(await s.mutate('updateManyItem', { where, set: { title: 'x' } }));
      const d = s.strip(await s.mutate('deleteManyItem', { where }));
      expect(m.errors).toEqual([
        { code: 'walks_in_mutation', path: ['updateManyItem', 'where', 'owner', '_walk'] }
      ]);
      expect(d.errors).toEqual([
        { code: 'walks_in_mutation', path: ['deleteManyItem', 'where', 'owner', '_walk'] }
      ]);
      return { m, d };
    });
  });

  it("type policy refusing set {status:'closed'} refuses updateMany with that set; nothing changes", async () => {
    const noClosing: Policy = (_c, args) =>
      args.params?.status === 'closed' ? { allow: false, reason: 'no closing' } : { allow: true };
    await onBoth(async (s) => {
      await s.seed(items(3));
      const before = await s.snapshot();
      const env = s.strip(
        await s.mutate('updateManyItem', {
          where: { status: { eq: 'open' } },
          set: { status: 'closed' }
        })
      );
      expect(env.errors).toEqual([{ code: 'policy_denied', path: ['updateManyItem'] }]);
      expect(await s.snapshot()).toEqual(before);
      // The same policy lets another set through.
      const ok = s.strip(
        await s.mutate('updateManyItem', { where: { status: { eq: 'open' } }, set: { title: 't' } })
      );
      expect(ok.errors).toEqual([]);
      return { env, ok };
    }, noClosing);
  });

  it('delete policy denying one matched id refuses deleteMany; nothing tombstoned', async () => {
    const keepOne: Policy = (c, args) =>
      c.verb === 'delete' && args.params?.id === 'i001'
        ? { allow: false, reason: 'i001 stays' }
        : { allow: true };
    await onBoth(async (s) => {
      await s.seed(items(3));
      const before = await s.snapshot();
      const env = s.strip(await s.mutate('deleteManyItem', { where: { status: { eq: 'open' } } }));
      expect(env.errors).toEqual([{ code: 'policy_denied', path: ['deleteManyItem'] }]);
      expect(await s.snapshot()).toEqual(before);
      return env;
    }, keepOne);
  });

  it('no subscriber registered: onWrite still fires once per changed row, and the rows are returned', async () => {
    await onBoth(async (s) => {
      await s.seed(items(3));
      await s.engine.hooksSettled();
      s.committed.length = 0;
      const env = s.strip(
        await s.mutate('updateManyItem', {
          where: { status: { eq: 'open' } },
          set: { title: 'seen' }
        })
      );
      expect(env.errors).toEqual([]);
      const del = s.strip(await s.mutate('deleteManyItem', { where: { title: { eq: 'seen' } } }));
      expect(del.errors).toEqual([]);
      await s.engine.hooksSettled();
      const hooks = s.committed.map((b) => ({
        type: b.type,
        operation: b.operation,
        ids: b.ids.map(String).sort()
      }));
      expect(hooks).toEqual([
        { type: 'Item', operation: 'update', ids: ['i000', 'i001', 'i002'] },
        { type: 'Item', operation: 'delete', ids: ['i000', 'i001', 'i002'] }
      ]);

      // The dataset primitives return the changed rows: post-images, then pre-images.
      await s.mutate(
        'createItem',
        items(2, 'closed').map((r) => ({ ...r, id: `n${String(r.id)}` }))
      );
      const updateWhere = s.dataset.updateWhere?.bind(s.dataset);
      const deleteWhere = s.dataset.deleteWhere?.bind(s.dataset);
      expect(updateWhere).toBeDefined();
      expect(deleteWhere).toBeDefined();
      const actor = { kind: 'agent' as const, id: 'tester' };
      const up = await updateWhere?.(
        'Item',
        { status: { eq: 'closed' } },
        { title: 'post' },
        {
          maxMatch: 5,
          actor,
          now: NOW
        }
      );
      const rowView = (rows: Array<Record<string, unknown>> | undefined) =>
        (rows ?? [])
          .map((r) => `${String(r.id)}:${String(r.title)}:${r._deletedAt == null}`)
          .sort();
      expect(up?.count).toBe(2);
      expect(rowView(up?.rows)).toEqual(['ni000:post:true', 'ni001:post:true']);
      const down = await deleteWhere?.('Item', { title: { eq: 'post' } }, { maxMatch: 5 });
      expect(down?.count).toBe(2);
      expect(rowView(down?.rows)).toEqual(['ni000:post:true', 'ni001:post:true']);
      return { hooks, up: rowView(up?.rows), down: rowView(down?.rows) };
    });
  });

  it('zero matches → {count:0, ids:[]}, not filter_too_broad', async () => {
    await onBoth(async (s) => {
      await s.seed(items(2));
      const up = s.strip(
        await s.mutate('updateManyItem', { where: { title: { eq: 'none' } }, set: { title: 'x' } })
      );
      const del = s.strip(await s.mutate('deleteManyItem', { where: { title: { eq: 'none' } } }));
      for (const [key, env] of [
        ['updateManyItem', up],
        ['deleteManyItem', del]
      ] as const) {
        expect(env.errors).toEqual([]);
        expect(env.data[key]).toEqual({ count: 0, ids: [], idsTruncated: false });
      }
      return { up, del };
    });
  });

  it.skipIf(POSTGRES_URL === undefined)(
    'row changed by a concurrent writer to no longer match is not updated',
    async () => {
      const s = await stack('pg', fresh());
      await s.seed(items(3));
      // Its own client, so the engine's pool is untouched.
      const blocker = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
      const conn = await blocker.reserve();
      try {
        await conn`BEGIN`;
        // Another writer moves i001 out of the filter and holds its row lock.
        await conn`
          UPDATE rows SET body = body || '{"status":"closed"}'::jsonb
          WHERE namespace = ${s.ns} AND type = 'Item' AND id = 'i001'`;
        const pending = s.mutate('updateManyItem', {
          where: { status: { eq: 'open' } },
          set: { title: 'swept' }
        });
        let settled = false;
        void pending.finally(() => {
          settled = true;
        });
        // Commit only once a backend is blocked by this one (the blocker's own
        // pid named in its pg_blocking_pids): the filter write, waiting on i001.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [row] = await conn<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
          if ((row?.n ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error('the filter write never blocked on the lock');
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(settled).toBe(false);
        await conn`COMMIT`;
        const env = s.strip(await pending);
        expect(env.errors).toEqual([]);
        expect(env.data.updateManyItem).toEqual({
          count: 2,
          ids: ['i000', 'i002'],
          idsTruncated: false
        });
        expect(await s.snapshot()).toEqual([
          'i000:swept:open:true',
          'i001:item 1:closed:true',
          'i002:swept:open:true'
        ]);
      } finally {
        conn.release();
        await blocker.end();
      }
    }
  );

  // Two filter writes over overlapping rows, run concurrently. `m` locks its
  // matches in id order, so they queue rather than deadlock (40P01).
  it.skipIf(POSTGRES_URL === undefined)(
    'overlapping concurrent updateMany calls do not deadlock',
    async () => {
      const s = await stack('pg', fresh());
      await s.seed([]);
      const rows = Array.from({ length: 300 }, (_, i) => ({
        id: `r${String(i).padStart(3, '0')}`,
        title: `t${String(i).padStart(3, '0')}`,
        status: 'open',
        owner: 'o0'
      }));
      // Stored in descending id order, so a scan on the body field visits rows
      // high id first while one on the id index visits them low id first:
      // without the id-ordered lock the two lock in opposite orders.
      await s.dataset.write('Item', [...rows].reverse());
      // The two sets overlap on r100..r199.
      const low = { title: { lt: 't200' } };
      const high = { id: { in: rows.slice(100).map((r) => r.id) } };
      const run = (where: Params, status: string) =>
        s.dataset.withTransaction(async (tx) => {
          if (tx.updateWhere === undefined) throw new Error('pg writes by filter');
          return tx.updateWhere('Item', where, { status }, { maxMatch: 1000 });
        });
      for (let round = 0; round < 15; round++) {
        const results = await Promise.allSettled([
          run(low, 'closed'),
          run(high, 'open'),
          run(high, 'closed'),
          run(low, 'open')
        ]);
        const failed = results.filter((r) => r.status === 'rejected');
        expect(
          failed.map((r) => String((r as PromiseRejectedResult).reason)),
          `round ${round}`
        ).toEqual([]);
      }
    }
  );
});
