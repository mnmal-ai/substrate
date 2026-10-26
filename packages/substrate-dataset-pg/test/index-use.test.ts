/**
 * The planner serves every operator a field kind allows from the index the
 * reconciler built. A mismatch between the index expression (or predicate)
 * and the compiled filter is a silent scan, so each case explains the
 * statement `read()` actually sends, twice: with its parameters (a custom
 * plan), and as a prepared statement under `force_generic_plan`.
 *
 * Derived per-field indexes and declared indexes are checked in both layouts.
 */

import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ORDERED_BY,
  type FieldDef,
  type IndexDecl,
  type ReadParams
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, reconcileTypeIndexes, type StorageLayout } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';
import type { PromotedBodyColumnMap } from '../src/pg-sql.js';
import { addTestPromotedColumns } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = (process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy') as StorageLayout;
const PARTITIONED = LAYOUT === 'partitioned';
const TYPE = 'Obs';
const ROWS = 5000;
const hex = () => randomBytes(4).toString('hex');
const COMPOSITE = `rows_iu_${hex()}`;
const PARTIAL = `rows_iu_partial_${hex()}`;
const PROMOTED_TEXT = `rows_iu_project_${hex()}`;
/** `project` lives in a promoted text column. */
const obsPromoted: PromotedBodyColumnMap = { project: { column: 'project', kind: 'text' } };

const fields: Record<string, FieldDef> = {
  title: { kind: 'scalar', type: 'string', indexed: true },
  n: { kind: 'scalar', type: 'number', indexed: true },
  at: { kind: 'scalar', type: 'date', indexed: true },
  owner: { kind: 'crossRef', ns: 'x', type: 'Owner', onDelete: 'set_null', indexed: true },
  tags: { kind: 'list', of: { kind: 'scalar', type: 'string' }, indexed: true },
  cert: { kind: 'scalar', type: 'string' },
  observedAt: { kind: 'scalar', type: 'date' },
  grp: { kind: 'scalar', type: 'string' },
  archived: { kind: 'scalar', type: 'boolean' },
  project: { kind: 'scalar', type: 'string' }
};
const indexes: IndexDecl[] = [
  { fields: ['cert', { field: 'observedAt', dir: 'desc' }], name: COMPOSITE },
  { fields: ['grp'], where: { archived: false }, name: PARTIAL },
  { fields: ['project'], name: PROMOTED_TEXT }
];

const ns = `iu_${hex()}`;
const iso = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

let sql: Sql;
/** A second client whose `debug` hook records each statement it sends. */
let traced: Sql;
let sent: Array<{ query: string; parameters: unknown[]; types: number[] }> = [];
let ds: PgDataset;

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  traced = postgres(POSTGRES_URL, {
    onnotice: () => {},
    debug: (_conn, query, parameters, types) => {
      sent.push({ query, parameters: parameters as unknown[], types: types as number[] });
    }
  });
  ds = new PgDataset({
    namespace: ns,
    sql: traced,
    promotedColumns: obsPromoted,
    fieldDefLookup: (type, field) => (type === TYPE ? fields[field] : undefined),
    typeDefLookup: (type) => (type === TYPE ? { fields, indexes } : undefined)
  });
  await addTestPromotedColumns(sql);
  await ds.ensureTypeStorage(TYPE);
  for (let start = 0; start < ROWS; start += 1000) {
    await ds.write(
      TYPE,
      Array.from({ length: 1000 }, (_, k) => {
        const i = start + k;
        return {
          id: `r${i}`,
          title: `t${String(i).padStart(5, '0')}`,
          n: i,
          at: iso(i),
          owner: `o${i % 500}`,
          tags: [`g${i % 100}`],
          cert: `c${i % 50}`,
          observedAt: iso(i),
          grp: `p${i % 50}`,
          archived: i % 2 === 0,
          project: `j${String(i).padStart(5, '0')}`
        };
      })
    );
  }
  await sql`ANALYZE rows`;
}, 120_000);

afterAll(async () => {
  await traced?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
});

/** The statement `read()` sends for `params`, with its bound values. */
async function compiled(
  params: ReadParams,
  dataset: PgDataset,
  type: string
): Promise<{ query: string; parameters: unknown[]; types: number[] }> {
  sent = [];
  await dataset.read(type, params);
  const q = sent.find((s) => /FROM rows r/.test(s.query));
  if (q === undefined) throw new Error('read sent no SELECT');
  return q;
}

type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };

/** `<node type> on <index>` for every index scan in the plan. */
function indexesUsed(node: PlanNode, out: string[] = []): string[] {
  if (/Index/.test(node['Node Type']) && node['Index Name'] !== undefined) {
    out.push(`${node['Node Type']} on ${node['Index Name']}`);
  }
  for (const child of node.Plans ?? []) indexesUsed(child, out);
  return out;
}

const planOf = (rows: Array<Record<string, unknown>>): PlanNode =>
  ((rows[0]?.['QUERY PLAN'] ?? []) as Array<{ Plan: PlanNode }>)[0]?.Plan as PlanNode;

/**
 * Index names in the plan of the prepared statement, under a forced custom
 * plan and then a forced generic one. The parameter types are the ones the
 * client declared, so both plans see the statement `read()` sent.
 */
async function plans(
  params: ReadParams,
  dataset: PgDataset = ds,
  type: string = TYPE
): Promise<{ custom: string[]; generic: string[] }> {
  const { query, parameters, types } = await compiled(params, dataset, type);
  const conn = await sql.reserve();
  try {
    const names = await conn<Array<{ t: string }>>`
      SELECT format_type(oid, NULL) AS t FROM unnest(${types}::oid[]) WITH ORDINALITY u(oid, k)
      ORDER BY k`;
    // The values as the client serialised them, as literals: EXPLAIN takes no bind parameters.
    const literals = parameters.map((p) =>
      p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`
    );
    // A read with no bound values prepares and executes without a parameter list.
    const list = (items: string[]) => (items.length === 0 ? '' : `(${items.join(', ')})`);
    await conn.unsafe(`PREPARE iu_stmt${list(names.map((n) => n.t))} AS ${query}`);
    const explain = async (mode: string): Promise<string[]> => {
      await conn.unsafe(`SET plan_cache_mode = ${mode}`);
      const rows = await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE iu_stmt${list(literals)}`);
      return indexesUsed(planOf(rows));
    };
    return {
      custom: await explain('force_custom_plan'),
      generic: await explain('force_generic_plan')
    };
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET plan_cache_mode');
    conn.release();
  }
}

const idx = (field: string, suffix = 'idx') => generatedIdentifier(ns, TYPE, field, suffix);

/** Asserts both plans scan `expected`, logging them when INDEX_USE_LOG is set. */
async function expectServedBy(
  name: string,
  p: { custom: string[]; generic: string[] },
  expected: string
): Promise<void> {
  if (process.env.INDEX_USE_LOG)
    console.log(`${name}\n  custom: ${p.custom}\n  generic: ${p.generic}`);
  const on = (scans: string[]) => scans.some((s) => s.endsWith(` on ${expected}`));
  expect(on(p.custom), `custom plan: ${p.custom}`).toBe(true);
  expect(on(p.generic), `generic plan: ${p.generic}`).toBe(true);
}

/** Served by derived per-field indexes, in both layouts. */
const implicitCases: Array<[string, ReadParams, () => string]> = [
  ['text eq', { where: { title: { eq: 't00042' } } }, () => idx('title')],
  ['text in', { where: { title: { in: ['t00001', 't00002'] } } }, () => idx('title')],
  [
    'text gt',
    { where: { title: { gt: 't04990' } }, orderBy: [{ title: 'asc' }], limit: 10 },
    () => idx('title')
  ],
  ['text between', { where: { title: { between: ['t00010', 't00020'] } } }, () => idx('title')],
  ['text orderBy', { orderBy: [{ title: 'asc' }], limit: 10 }, () => idx('title')],
  ['number eq', { where: { n: { eq: 42 } } }, () => idx('n')],
  ['number gt', { where: { n: { gt: 4990 } }, orderBy: [{ n: 'asc' }], limit: 10 }, () => idx('n')],
  ['number between', { where: { n: { between: [10, 20] } } }, () => idx('n')],
  ['number orderBy', { orderBy: [{ n: 'asc' }], limit: 10 }, () => idx('n')],
  [
    'date gte',
    { where: { at: { gte: iso(4990) } }, orderBy: [{ at: 'desc' }], limit: 10 },
    () => idx('at')
  ],
  // Spec rule (derived keys): natural order replaced the implicit date DESC
  // rule, so the derived date index is ascending and serves an ascending read.
  ['date orderBy asc', { orderBy: [{ at: 'asc' }], limit: 10 }, () => idx('at')],
  ['crossRef eq', { where: { owner: { eq: 'o7' } } }, () => idx('owner')],
  ['crossRef in', { where: { owner: { in: ['o7', 'o8'] } } }, () => idx('owner')],
  // GIN for list fields stays partitioned-only; legacy derives it by migration.
  ...(PARTITIONED
    ? ([['list has', { where: { tags: { has: 'g7' } } }, () => idx('tags', 'gin')]] satisfies Array<
        [string, ReadParams, () => string]
      >)
    : [])
];

/** Served by declared indexes, in both layouts. */
const declaredCases: Array<[string, ReadParams, () => string]> = [
  [
    'composite eq + orderBy desc',
    { where: { cert: { eq: 'c7' } }, orderBy: [{ observedAt: 'desc' }], limit: 10 },
    () => COMPOSITE
  ],
  ['promoted text eq', { where: { project: { eq: 'j00042' } } }, () => PROMOTED_TEXT],
  ['promoted text in', { where: { project: { in: ['j00001', 'j00002'] } } }, () => PROMOTED_TEXT],
  [
    'promoted text between',
    { where: { project: { between: ['j00010', 'j00020'] } } },
    () => PROMOTED_TEXT
  ],
  ['promoted text orderBy', { orderBy: [{ project: 'asc' }], limit: 10 }, () => PROMOTED_TEXT],
  [
    'partial (archived: false) eq',
    { where: { grp: { eq: 'p7' }, archived: { eq: false } } },
    () => PARTIAL
  ]
];

describe.skipIf(!POSTGRES_URL)('index use: derived indexes', () => {
  for (const [name, params, expected] of implicitCases) {
    it(name, async () => expectServedBy(name, await plans(params), expected()));
  }
});

describe.skipIf(!POSTGRES_URL)('index use: declared indexes', () => {
  for (const [name, params, expected] of declaredCases) {
    it(name, async () => expectServedBy(name, await plans(params), expected()));
  }

  it('a stored value with no offset is UTC: it matches gt and sorts in place under the index', async () => {
    const at: Record<string, string> = {
      nz1: '2026-06-01T10:00:00',
      nz2: '2026-06-01T09:00:00Z',
      nz3: '2026-06-01T11:00:00+00:00',
      nz4: '2026-06-01',
      nz5: '2026-06-01T10:30:00.1234567',
      nz6: '2026-06-01T12:15:00+02:00'
    };
    await ds.write(
      TYPE,
      Object.entries(at).map(([id, observedAt]) => ({ id, cert: 'cNZ', observedAt }))
    );
    try {
      const params: ReadParams = {
        where: { cert: { eq: 'cNZ' }, observedAt: { gt: '2026-06-01T09:30:00' } },
        orderBy: [{ observedAt: 'desc' }],
        limit: 10
      };
      // Plans first: the helper reads the parameter types of the statement's first send.
      await expectServedBy('no-offset gt + orderBy desc', await plans(params), COMPOSITE);
      const { rows } = await ds.read(TYPE, params);
      expect(rows.map((r) => r.id)).toEqual(['nz3', 'nz5', 'nz6', 'nz1']);
    } finally {
      await ds.purge(TYPE, Object.keys(at));
    }
  });

  // cortext's AgentMessage: `status` and `archived` are promoted columns, and
  // the fleet already holds a hand-built index of the declared name whose
  // predicate is `archived IS NOT TRUE`.
  it('swaps a legacy-style index over promoted columns, and the swap serves reads', async () => {
    const type = 'AgentMessage';
    const msgNs = `iu_msg_${hex()}`;
    const name = `rows_agent_message_recipient_idx_${hex()}`;
    const promotedColumns: PromotedBodyColumnMap = {
      status: { column: 'status', kind: 'text' },
      archived: { column: 'archived', kind: 'boolean' }
    };
    const msgFields: Record<string, FieldDef> = {
      recipient: { kind: 'crossRef', ns: msgNs, type: 'AgentIdentity', onDelete: 'set_null' },
      status: { kind: 'scalar', type: 'string' },
      archived: { kind: 'scalar', type: 'boolean' }
    };
    const msgs = new PgDataset({
      namespace: msgNs,
      sql: traced,
      promotedColumns,
      fieldDefLookup: (_t, f) => msgFields[f]
    });
    await msgs.ensureTypeStorage(type);
    await msgs.write(
      type,
      Array.from({ length: ROWS }, (_, i) => ({
        id: `m${i}`,
        recipient: `u${i % 200}`,
        status: `s${i % 5}`,
        archived: i % 2 === 0
      }))
    );
    const [part] = await sql<Array<{ relname: string }>>`
      SELECT c.relname FROM pg_partition_tree('rows') t JOIN pg_class c ON c.oid = t.relid
      WHERE t.isleaf AND pg_get_expr(c.relpartbound, c.oid) = ${`FOR VALUES IN ('${type}')`}
        AND t.parentrelid = (
          SELECT c2.oid FROM pg_partition_tree('rows') t2 JOIN pg_class c2 ON c2.oid = t2.relid
          WHERE pg_get_expr(c2.relpartbound, c2.oid) = ${`FOR VALUES IN ('${msgNs}')`})`;
    const target = PARTITIONED ? (part?.relname as string) : 'rows';
    const scope = PARTITIONED ? '' : `namespace = '${msgNs}' AND type = '${type}' AND `;
    await sql.unsafe(
      `CREATE INDEX ${name} ON ${target} ((body ->> 'recipient'), status)
       WHERE ${scope}deleted_at IS NULL AND archived IS NOT TRUE`
    );

    const states = await reconcileTypeIndexes(sql, {
      namespace: msgNs,
      type,
      layout: LAYOUT,
      orderedBy: DEFAULT_ORDERED_BY,
      fields: msgFields,
      promotedColumns,
      indexes: [{ fields: ['recipient', 'status'], where: { archived: false }, name }]
    });
    expect(states.find((s) => s.name === name)).toMatchObject({
      outcome: 'swapped',
      state: 'valid'
    });
    await sql.unsafe(`ANALYZE ${target}`);
    await expectServedBy(
      'promoted partial (recipient, status) where archived = false',
      await plans(
        { where: { recipient: { eq: 'u7' }, status: { eq: 's2' }, archived: { eq: false } } },
        msgs,
        type
      ),
      name
    );
  });
});

/** Every node type in the plan. */
const nodeTypes = (node: PlanNode, out: string[] = []): string[] => {
  out.push(node['Node Type']);
  for (const child of node.Plans ?? []) nodeTypes(child, out);
  return out;
};

/** The plan of the statement `read()` sends for `params`, under a forced custom (or `mode`) plan. */
async function customPlan(
  params: ReadParams,
  dataset: PgDataset,
  type: string,
  mode: 'force_custom_plan' | 'force_generic_plan' = 'force_custom_plan'
): Promise<PlanNode> {
  const { query, parameters, types } = await compiled(params, dataset, type);
  const conn = await sql.reserve();
  try {
    const names = await conn<Array<{ t: string }>>`
      SELECT format_type(oid, NULL) AS t FROM unnest(${types}::oid[]) WITH ORDINALITY u(oid, k)
      ORDER BY k`;
    const literals = parameters
      .map((p) => (p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`))
      .join(', ');
    // A repeated statement reports type 0 (the client reuses its prepared one): let pg infer.
    const declared = types.includes(0) ? '' : `(${names.map((n) => n.t).join(', ')})`;
    await conn.unsafe(`PREPARE iu_custom${declared} AS ${query}`);
    await conn.unsafe(`SET plan_cache_mode = ${mode}`);
    return planOf(await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE iu_custom(${literals})`));
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET plan_cache_mode');
    conn.release();
  }
}

// A declaration may key on a metadata column, as natural order does: the
// index advisor's `{ fields: [eq, { field: 'createdAt', dir: 'desc' }] }`.
describe.skipIf(!POSTGRES_URL)('index use: a declared metadata order key', () => {
  const taskNs = `iu_task_${hex()}`;
  const type = 'Task';
  const taskFields: Record<string, FieldDef> = { status: { kind: 'scalar', type: 'string' } };
  const N = 20_000;
  let tasks: PgDataset;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    tasks = new PgDataset({
      namespace: taskNs,
      sql: traced,
      fieldDefLookup: (_t, f) => taskFields[f],
      typeDefLookup: () => ({
        fields: taskFields,
        indexes: [{ fields: ['status', { field: 'createdAt', dir: 'desc' }] }]
      })
    });
    await tasks.ensureTypeStorage(type);
    for (let start = 0; start < N; start += 2000) {
      await tasks.write(
        type,
        Array.from({ length: 2000 }, (_, k) => ({
          id: `t${start + k}`,
          status: `s${(start + k) % 20}`
        }))
      );
    }
    await sql`ANALYZE rows`;
  }, 120_000);

  it('status eq in the default order, limit 10: the declared index, no Sort under the limit', async () => {
    const name = generatedIdentifier(taskNs, type, 'status_createdAt', 'idx');
    const params: ReadParams = {
      where: { status: { eq: 's7' } },
      orderBy: [{ ...DEFAULT_ORDERED_BY }],
      limit: 10
    };
    for (const mode of ['force_custom_plan', 'force_generic_plan'] as const) {
      const plan = await customPlan(params, tasks, type, mode);
      expect(indexesUsed(plan), `${mode}: ${JSON.stringify(nodeTypes(plan))}`).toContain(
        `Index Scan on ${name}`
      );
      const limit = (n: PlanNode): PlanNode | undefined =>
        n['Node Type'] === 'Limit' ? n : (n.Plans ?? []).map(limit).find((x) => x !== undefined);
      const under = limit(plan);
      expect(under, mode).toBeDefined();
      expect(
        nodeTypes(under as PlanNode).filter((t) => /Sort/.test(t)),
        mode
      ).toEqual([]);
    }
  });
});

// The default order ends with `id`, so a non-unique index that does not end
// with it serves the filter but not the order: the planner either sorts every
// match or walks the primary key in id order, filtering every row.
describe.skipIf(!POSTGRES_URL)('index use: the default order', () => {
  const certNs = `iu_cert_${hex()}`;
  const type = 'Cert';
  const name = `rows_iu_cert_${hex()}`;
  const certFields: Record<string, FieldDef> = {
    cert: { kind: 'scalar', type: 'string' },
    ref: { kind: 'crossRef', ns: 'x', type: 'Ref', onDelete: 'set_null' }
  };
  // The matches must estimate well above the limit for an ordered range scan
  // to beat fetching them all and sorting: 1,000 here.
  const N = 100_000;
  let certs: PgDataset;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    certs = new PgDataset({
      namespace: certNs,
      sql: traced,
      fieldDefLookup: (_t, f) => certFields[f],
      typeDefLookup: () => ({ fields: certFields, indexes: [{ fields: ['cert'], name }] })
    });
    await certs.ensureTypeStorage(type);
    for (let start = 0; start < N; start += 2000) {
      await certs.write(
        type,
        Array.from({ length: 2000 }, (_, k) => ({
          id: `c${start + k}`,
          cert: `x${(start + k) % 100}`,
          ref: `r${(start + k) % 100}`
        }))
      );
    }
    await sql`ANALYZE rows`;
  }, 120_000);

  it('where <field> = X, limit 100: one range scan of the declared index, no Sort', async () => {
    const plan = await customPlan({ where: { cert: { eq: 'x7' } }, limit: 100 }, certs, type);
    if (process.env.INDEX_USE_LOG) console.log(JSON.stringify(plan, null, 1));
    expect(indexesUsed(plan), JSON.stringify(nodeTypes(plan))).toContain(`Index Scan on ${name}`);
    expect(nodeTypes(plan).filter((t) => /Sort/.test(t))).toEqual([]);
  });

  it('where ref = X in the natural order, limit 10: the derived index, no Sort under the limit', async () => {
    const params: ReadParams = {
      where: { ref: { eq: 'r7' } },
      orderBy: [{ createdAt: 'desc' }],
      limit: 10
    };
    // Generic too: on legacy the partial index serves only if the planner
    // proves its inlined ns/type predicate without the bound values.
    for (const mode of ['force_custom_plan', 'force_generic_plan'] as const) {
      const plan = await customPlan(params, certs, type, mode);
      if (process.env.INDEX_USE_LOG) console.log(mode, JSON.stringify(plan, null, 1));
      expect(indexesUsed(plan), `${mode}: ${JSON.stringify(nodeTypes(plan))}`).toContain(
        `Index Scan on ${generatedIdentifier(certNs, type, 'ref', 'idx')}`
      );
      // The read re-sorts its at most limit + 1 rows after the short-id join, by
      // the projected timestamp text; what matters is that no Sort sits under
      // the LIMIT, where it would sort every match.
      const limit = (n: PlanNode): PlanNode | undefined =>
        n['Node Type'] === 'Limit' ? n : (n.Plans ?? []).map(limit).find((x) => x !== undefined);
      const under = limit(plan);
      expect(under, `${mode}: ${JSON.stringify(nodeTypes(plan))}`).toBeDefined();
      expect(
        nodeTypes(under as PlanNode).filter((t) => /Sort/.test(t)),
        mode
      ).toEqual([]);
    }
  });

  it('keyset paging over where <field> = X returns every match exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await certs.read(type, {
        where: { cert: { eq: 'x7' } },
        limit: 100,
        ...(cursor === undefined ? {} : { cursor })
      });
      seen.push(...res.rows.map((r) => String(r.id)));
      if (res.nextCursor === undefined || res.rows.length === 0) break;
      cursor = res.nextCursor;
    }
    const expected = Array.from({ length: N / 100 }, (_, k) => `c${k * 100 + 7}`);
    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen)).toEqual(new Set(expected));
  });
});

/** Every `Index Cond` and every `Filter` in the plan. */
const conditions = (
  node: PlanNode & { 'Index Cond'?: string; Filter?: string },
  out: { cond: string[]; filter: string[] } = { cond: [], filter: [] }
): { cond: string[]; filter: string[] } => {
  if (node['Index Cond'] !== undefined) out.cond.push(node['Index Cond']);
  if (node.Filter !== undefined) out.filter.push(node.Filter);
  for (const child of node.Plans ?? []) conditions(child, out);
  return out;
};

// `id` is NOT NULL, so its keyset compare carries no `IS NULL` arm and the
// primary key serves it as a range rather than filtering every earlier row.
describe.skipIf(!POSTGRES_URL)('index use: id keyset cursor', () => {
  const byId: ReadParams = { orderBy: [{ id: 'asc' }], limit: 500 };

  it('page 2 of an id-ordered read bounds id in an Index Cond, with no IS NULL filter', async () => {
    const { nextCursor } = await ds.read(TYPE, byId);
    if (nextCursor === undefined) throw new Error('page 1 returned no cursor');
    const plan = await customPlan({ ...byId, cursor: nextCursor }, ds, TYPE);
    if (process.env.INDEX_USE_LOG) console.log(JSON.stringify(plan, null, 1));
    const { cond, filter } = conditions(plan);
    expect(
      cond.some((c) => /\bid > /.test(c)),
      JSON.stringify(cond)
    ).toBe(true);
    expect(filter.filter((f) => /IS NULL/.test(f) && /\bid\b/.test(f))).toEqual([]);
  });

  it('id-ordered keyset paging returns every row exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ROWS / 500 + 2; page++) {
      const res = await ds.read(TYPE, { ...byId, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...res.rows.map((r) => String(r.id)));
      if (res.nextCursor === undefined || res.rows.length === 0) break;
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen).size).toBe(ROWS);
    expect(seen).toEqual([...seen].sort());
  });
});

/** The estimated rows of the scan on the type's table. */
const scanRows = (
  node: PlanNode & { 'Relation Name'?: string; 'Plan Rows'?: number }
): number | undefined => {
  if (node['Relation Name'] !== undefined && node['Relation Name'] !== 'short_ids')
    return node['Plan Rows'];
  for (const child of node.Plans ?? []) {
    const rows = scanRows(child);
    if (rows !== undefined) return rows;
  }
  return undefined;
};

// Every reconciled index is partial, and the planner reads no expression
// statistics from a partial index; without the reconciler's statistics object
// every value of `body ->> f` estimates at the same default selectivity.
describe.skipIf(!POSTGRES_URL)('index use: expression statistics', () => {
  const statNs = `iu_stat_${hex()}`;
  const type = 'Grade';
  const name = `rows_iu_grade_${hex()}`;
  const gradeFields: Record<string, FieldDef> = { grade: { kind: 'scalar', type: 'string' } };
  const N = 30_000;
  let grades: PgDataset;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    grades = new PgDataset({
      namespace: statNs,
      sql: traced,
      fieldDefLookup: (_t, f) => gradeFields[f],
      typeDefLookup: () => ({ fields: gradeFields, indexes: [{ fields: ['grade'], name }] })
    });
    // Builds the index and its statistics object, before the rows exist.
    await grades.ensureTypeStorage(type);
    // 10% share one hot value; the rest hold a value of their own.
    for (let start = 0; start < N; start += 3000) {
      await grades.write(
        type,
        Array.from({ length: 3000 }, (_, k) => {
          const i = start + k;
          return { id: `g${i}`, grade: i % 10 === 0 ? 'hot' : `rare${i}` };
        })
      );
    }
    await sql`ANALYZE rows`;
  }, 120_000);

  it('estimates a hot value well above a rare one', async () => {
    const hot = scanRows(await customPlan({ where: { grade: { eq: 'hot' } } }, grades, type));
    const rare = scanRows(await customPlan({ where: { grade: { eq: 'rare7' } } }, grades, type));
    expect(hot, `hot ${hot}, rare ${rare}`).toBeGreaterThanOrEqual(10 * (rare ?? Number.NaN));
  });
});
