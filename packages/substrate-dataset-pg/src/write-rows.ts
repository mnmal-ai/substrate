/**
 * The `tables` layout's row writes: one statement for any number of rows.
 * `PgDataset.write` upserts through {@link writeRowsStatement}, and its patch
 * paths merge through {@link inputCte} and {@link mergeAssignments}, so every
 * write applies `applyPatch`'s rule (row-codec.ts) in SQL:
 *
 * - a column the row writes takes its value (NULL for a cleared field), and
 *   one it does not write keeps the stored value;
 * - `extra` loses every key the row writes (`unset`) and the old `$raw`, then
 *   takes the row's `extra`; `$raw` loses the written keys, takes the row's
 *   `$raw`, and is dropped when it ends empty.
 *
 * So no declared column key is ever left in `extra` by a write (F13).
 */

import type { ActorIdentity, RowMetadata } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { columnSql, type Fragment, sqlStringLiteral } from './pg-sql/primitives.js';
import { buildRowProjection } from './pg-sql/projection.js';
import { type EncodedRow, RAW_KEY } from './row-codec.js';
import type { ColumnKind, TypedColumn, TypeTable } from './type-table.js';

/** An encoded row with its id (`null` takes `uuidv7()`) and, for a write, its metadata. */
export interface RowToWrite extends EncodedRow {
  id: string | null;
  metadata?: RowMetadata | null;
  /** `'passthrough'` only: the stored `deleted_at` (timestamptz text) and `seq` (bigint text) of an inserted row. */
  deletedAt?: string | null;
  seq?: string | null;
}

export interface WriteRowsOptions {
  /** A row whose id exists is skipped, not merged. */
  insertOnly: boolean;
  /** Each inserted row takes the type's next `seq`, in input order. The caller holds the seq lock. */
  visibleOrder: boolean;
  /**
   * `'stamp'`: a row without metadata gets `now` and `actor`, and a merge keeps
   * `created_*` and a null `updated_*`, as `write` always has. `'passthrough'`:
   * each row's metadata columns are stored as given (F37), and an inserted
   * row's `deleted_at` and `seq` too, so `visibleOrder` must be off.
   */
  metadata: 'stamp' | 'passthrough';
  actor?: ActorIdentity | null;
  now?: Date;
}

/** The SQL type an input column is cast to; every value is bound as text. */
const CAST: Readonly<Record<ColumnKind, string>> = {
  text: 'text',
  enum: 'text',
  crossRef: 'text',
  number: 'float8',
  date: 'timestamptz',
  boolean: 'boolean'
};

/** The columns a write sets: an orphaned column's field is undeclared, so it goes to `extra`. */
export function writableColumns(table: TypeTable): TypedColumn[] {
  return table.columns().filter((c) => c.state !== 'orphaned');
}

/** `[a, ',', b, ',', c]`, which postgres.js joins into one flat template. */
function commaList(sql: Sql | TransactionSql, parts: Fragment[]): Fragment[] {
  return parts.flatMap((p, i) => (i === 0 ? [p] : [sql`,`, p]));
}

const META = ['ca', 'ua', 'cbk', 'cbi', 'ubk', 'ubi'] as const;

/**
 * `input AS (…)`: one row per encoded row, in order (`ord`), from one typed
 * array per column (F21: `unset` travels as a JSON array per row, since a
 * `text[][]` must be rectangular). Columns: `rid` (a null id takes
 * `uuidv7()`), `ex` and `rw` jsonb, `un` text[], `c<k>` per writable column,
 * and the metadata columns when `metadata` is given.
 */
export function inputCte(
  sql: Sql | TransactionSql,
  table: TypeTable,
  rows: ReadonlyArray<EncodedRow & { id: string | null }>,
  metadata?: ReadonlyArray<RowMetadata | null>,
  /** `da` (deleted_at) and `ps` (seq) columns, from `RowToWrite`'s passthrough fields. */
  stored?: ReadonlyArray<Pick<RowToWrite, 'deletedAt' | 'seq'>>
): Fragment {
  const cols = writableColumns(table);
  const arrays: unknown[][] = [
    rows.map((r) => r.id),
    rows.map((r) => JSON.stringify(r.extra)),
    rows.map((r) => JSON.stringify(r.raw)),
    rows.map((r) => JSON.stringify(r.unset)),
    ...cols.map((c) =>
      rows.map((r) => {
        const v = Object.hasOwn(r.columns, c.column) ? r.columns[c.column] : null;
        return v === null || v === undefined ? null : String(v);
      })
    )
  ];
  const names = ['rid', 'ex', 'rw', 'un', ...cols.map((_, k) => `c${k}`)];
  const selects = [
    'COALESCE(x.rid, uuidv7()::text) AS rid',
    'x.ord',
    'x.ex::jsonb AS ex',
    'x.rw::jsonb AS rw',
    'ARRAY(SELECT jsonb_array_elements_text(x.un::jsonb)) AS un',
    ...cols.map((c, k) => `x.c${k}::${CAST[c.kind]} AS c${k}`)
  ];
  if (metadata !== undefined) {
    arrays.push(
      metadata.map((m) => m?.createdAt ?? null),
      metadata.map((m) => m?.updatedAt ?? null),
      metadata.map((m) => m?.createdBy?.kind ?? null),
      metadata.map((m) => m?.createdBy?.id ?? null),
      metadata.map((m) => m?.updatedBy?.kind ?? null),
      metadata.map((m) => m?.updatedBy?.id ?? null)
    );
    names.push(...META);
    selects.push(
      'x.ca::timestamptz AS ca',
      'x.ua::timestamptz AS ua',
      'x.cbk',
      'x.cbi',
      'x.ubk',
      'x.ubi'
    );
  }
  if (stored !== undefined) {
    arrays.push(
      stored.map((r) => r.deletedAt ?? null),
      stored.map((r) => r.seq ?? null)
    );
    names.push('da', 'ps');
    selects.push('x.da::timestamptz AS da', 'x.ps::bigint AS ps');
  }
  // Text, cast in SQL: postgres.js's bulk path does not round-trip jsonb, and a
  // Date parameter keeps milliseconds only.
  const unnest = commaList(
    sql,
    arrays.map((a) => sql`${a as string[]}::text[]`)
  );
  return sql`input AS (
    SELECT ${sql.unsafe(selects.join(', '))}
    FROM unnest(${unnest}) WITH ORDINALITY AS x(${sql.unsafe(names.join(', '))}, ord)
  )`;
}

/**
 * The merged `extra` of input row `i` over stored row `t` (`null`: no stored
 * row): `(t.extra - un - '$raw') || ex || {$raw: (t.extra->'$raw' - un) || rw}`,
 * the `$raw` key only when that is non-empty.
 */
function mergedExtraSql(t: string | null, i: string): string {
  const raw = `${sqlStringLiteral(RAW_KEY)}::text`;
  const prior = t === null ? `'{}'::jsonb` : `${t}.extra`;
  // COALESCE: `- un` on a missing `$raw` would give NULL, which would write `{"$raw": null}`.
  const rawm = `((COALESCE(${prior} -> ${raw}, '{}'::jsonb) - ${i}.un) || ${i}.rw)`;
  return `((${prior} - (${i}.un || ${raw})) || ${i}.ex || CASE WHEN ${rawm} = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object(${raw}, ${rawm}) END)`;
}

/**
 * `[target, expression]` pairs merging input row `i` over stored row `t`: each
 * writable column takes `i`'s value when the row writes its field, else keeps
 * `t`'s; then `extra`. Text only (names are validated or inlined as literals).
 */
export function mergeAssignments(table: TypeTable, t: string, i: string): Array<[string, string]> {
  const out: Array<[string, string]> = writableColumns(table).map((c, k) => {
    const col = columnSql(c);
    return [
      col,
      `CASE WHEN ${sqlStringLiteral(c.field)} = ANY(${i}.un) THEN ${i}.c${k} ELSE ${t}.${col} END`
    ];
  });
  out.push(['extra', mergedExtraSql(t, i)]);
  return out;
}

/** `a = x, b = y` from {@link mergeAssignments}-shaped pairs. */
export function setList(pairs: ReadonlyArray<[string, string]>): string {
  return pairs.map(([c, e]) => `${c} = ${e}`).join(', ');
}

/** The metadata assignments of a merge: `stamp` keeps `created_*` and a null `updated_*`. */
function metadataAssignments(
  mode: WriteRowsOptions['metadata'],
  t: string,
  i: string
): Array<[string, string]> {
  const pairs: Array<[string, string, 'old' | 'new']> = [
    ['created_at', 'ca', 'old'],
    ['updated_at', 'ua', 'new'],
    ['created_by_kind', 'cbk', 'old'],
    ['created_by_id', 'cbi', 'old'],
    ['updated_by_kind', 'ubk', 'new'],
    ['updated_by_id', 'ubi', 'new']
  ];
  return pairs.map(([col, v, wins]) => [
    col,
    mode === 'passthrough'
      ? `${i}.${v}`
      : wins === 'old'
        ? `COALESCE(${t}.${col}, ${i}.${v})`
        : `COALESCE(${i}.${v}, ${t}.${col})`
  ]);
}

/**
 * The SELECT list a type-table row is returned with, for `decodeRow` and
 * `assembleRowMetadata`: `alias`'s id, columns (dates as UTC text) and
 * `extra`, its metadata, and `s.short_id`.
 */
export function returnedRowSql(
  sql: Sql | TransactionSql,
  table: TypeTable,
  alias: string,
  fields?: Record<string, unknown>
): Fragment {
  const a = (c: string) => `${alias}.${c}`;
  return sql`${sql.unsafe(a('id'))}, ${buildRowProjection(sql, table, fields as never, alias)},
    ${sql.unsafe(
      [
        'deleted_at',
        'created_at',
        'updated_at',
        'created_by_kind',
        'created_by_id',
        'updated_by_kind',
        'updated_by_id',
        'seq'
      ]
        .map(a)
        .join(', ')
    )}, s.short_id`;
}

/** `LEFT JOIN short_ids s` on the row of `table`'s type whose id is `id` (an SQL expression). */
export function shortIdJoinSql(table: TypeTable, id: string): string {
  return `LEFT JOIN short_ids s ON s.namespace = ${sqlStringLiteral(table.namespace)} AND s.type = ${sqlStringLiteral(table.type)} AND s.row_id = ${id}`;
}

/**
 * One statement upserting `rows` into `table`, registering each inserted id in
 * `row_ids`, and returning the stored rows in input order (a repeated id at
 * its first place) in {@link returnedRowSql}'s shape.
 *
 * A stored row is merged by an UPDATE that reads the input row whole; the rest
 * are INSERTed. A row another transaction inserts meanwhile conflicts, and the
 * conflict arm merges the same way, looking its input row up by id: the only
 * path that searches the input, and only for those rows. `insertOnly` skips
 * the UPDATE and every conflict. A merge never touches `deleted_at`.
 *
 * Visible order: as on `rows`, `seqd` numbers the rows that will be inserted
 * from the type's last seq, and `counted` advances it.
 */
export function writeRowsStatement(
  sql: Sql | TransactionSql,
  table: TypeTable,
  rows: readonly RowToWrite[],
  opts: WriteRowsOptions
): Fragment {
  const passthrough = opts.metadata === 'passthrough';
  if (passthrough && opts.visibleOrder) {
    throw new Error(
      "writeRowsStatement: 'passthrough' writes each row's seq, so visibleOrder must be off"
    );
  }
  const now = (opts.now ?? new Date()).toISOString();
  const actor = opts.actor ?? null;
  const metadata = rows.map((r) =>
    r.metadata != null || opts.metadata === 'passthrough'
      ? (r.metadata ?? null)
      : { createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor }
  );
  const ns = sqlStringLiteral(table.namespace);
  const ty = sqlStringLiteral(table.type);
  const target = sql.unsafe(table.from);
  const cols = writableColumns(table);
  const merge = [
    ...mergeAssignments(table, 't', 'i'),
    ...metadataAssignments(opts.metadata, 't', 'i')
  ];

  const seqCtes = opts.visibleOrder
    ? sql`,
      seqd AS (
        SELECT f.*, CASE WHEN f.fresh THEN
            COALESCE((SELECT v.last_seq FROM visible_seqs v WHERE v.namespace = ${sql.unsafe(ns)} AND v.type = ${sql.unsafe(ty)}), 0)
            + count(*) FILTER (WHERE f.fresh) OVER (ORDER BY f.ord)
          END AS sq
        FROM (
          SELECT i.*, i.ord = min(i.ord) OVER (PARTITION BY i.rid) AS first,
                 i.ord = min(i.ord) OVER (PARTITION BY i.rid) AND NOT EXISTS (
                   SELECT 1 FROM ${target} r WHERE r.id = i.rid
                 ) AS fresh
          FROM input i
        ) f
      ),
      counted AS (
        INSERT INTO visible_seqs (namespace, type, last_seq)
        SELECT ${sql.unsafe(ns)}, ${sql.unsafe(ty)}, max(sq) FROM seqd WHERE sq IS NOT NULL
        HAVING max(sq) IS NOT NULL
        ON CONFLICT (namespace, type) DO UPDATE SET last_seq = EXCLUDED.last_seq
      )`
    : sql``;

  const upd = opts.insertOnly
    ? sql``
    : sql`,
      upd AS (
        UPDATE ${target} t SET ${sql.unsafe(setList(merge))}
        FROM input i WHERE t.id = i.rid
        RETURNING t.*
      )`;

  const insertCols = [
    'id',
    'extra',
    ...cols.map((c) => columnSql(c)),
    'created_at',
    'updated_at',
    'created_by_kind',
    'created_by_id',
    'updated_by_kind',
    'updated_by_id',
    ...(opts.visibleOrder ? ['seq'] : []),
    ...(passthrough ? ['deleted_at', 'seq'] : [])
  ];
  const insertValues = [
    'i.rid',
    mergedExtraSql(null, 'i'),
    ...cols.map((_, k) => `i.c${k}`),
    ...META.map((m) => `i.${m}`),
    ...(opts.visibleOrder ? ['i.sq'] : []),
    ...(passthrough ? ['i.da', 'i.ps'] : [])
  ];
  // A repeated id's later occurrences are skipped under insertOnly anyway;
  // leaving them out makes the first one the one that lands, with its seq.
  const source = opts.visibleOrder ? 'seqd i WHERE i.first' : 'input i WHERE true';
  const notUpdated = opts.insertOnly
    ? ''
    : ' AND NOT EXISTS (SELECT 1 FROM upd WHERE upd.id = i.rid)';
  const onConflict = opts.insertOnly
    ? 'ON CONFLICT (id) DO NOTHING'
    : `ON CONFLICT (id) DO UPDATE SET (${merge.map(([c]) => c).join(', ')}) = (SELECT ${merge
        .map(([, e]) => e)
        .join(', ')} FROM input i WHERE i.rid = EXCLUDED.id)`;

  return sql`
    WITH ${inputCte(sql, table, rows, metadata, passthrough ? rows : undefined)}${seqCtes}${upd},
    ins AS (
      INSERT INTO ${target} AS t (${sql.unsafe(insertCols.join(', '))})
      SELECT ${sql.unsafe(insertValues.join(', '))}
      FROM ${sql.unsafe(source + notUpdated)}
      ${sql.unsafe(onConflict)}
      RETURNING t.*
    ),
    reg AS (
      INSERT INTO row_ids (namespace, type, id)
      SELECT ${sql.unsafe(ns)}, ${sql.unsafe(ty)}, id FROM ins
      ON CONFLICT DO NOTHING
    )
    SELECT ${returnedRowSql(sql, table, 'u')}
    FROM (${opts.insertOnly ? sql`` : sql`SELECT * FROM upd UNION ALL `}SELECT * FROM ins) u
    JOIN (SELECT rid, min(ord) AS ord FROM input GROUP BY rid) o ON o.rid = u.id
    ${sql.unsafe(shortIdJoinSql(table, 'u.id'))}
    ORDER BY o.ord
  `;
}
