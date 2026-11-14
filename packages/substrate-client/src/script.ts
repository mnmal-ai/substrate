import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import type { SubstrateClient } from './client.js';
import type { QualifiedFrame } from './transport/http.js';

/**
 * `read` refuses every mutation, `dry-run` records mutations without sending
 * them, and `write` sends them up to `maxWrites` frames.
 */
export type ScriptMode = 'read' | 'dry-run' | 'write';

export interface ScriptMutation {
  frame: QualifiedFrame;
  /** True when any op-key came back with data; a refused payload otherwise rolls back whole. */
  applied: boolean;
  errors?: PackEnvelope['errors'];
}

export interface ScriptRecallInput {
  query: string;
  /** Required, as on every recall surface. */
  namespace: string;
  /** Required, as on every recall surface: there is no default type. */
  type: string;
  k?: number;
  threshold?: number;
  where?: Record<string, unknown>;
  /** `true` for the whole row, or the fields to return beside `id`. Omit for the handle fields. */
  row?: true | Record<string, true>;
}

/**
 * A recall hit's `row`. Without `row` in the request it is `id` plus whichever
 * handle fields the row has (recall's HANDLE_FIELDS); `row: { body: true }` or
 * `row: true` adds `body` and the other fields asked for.
 */
export interface RecallHitRow {
  id: string;
  name?: string;
  title?: string;
  topic?: string;
  synopsis?: string;
  description?: string;
  /** Present only when the request asked for it and the type has one. */
  body?: string;
  [field: string]: unknown;
}

/** One `recall/Hit` row, as the recall frame returns it. */
export interface RecallHit {
  /** The hit row's id, the same as `row.id`. */
  id: string;
  namespace: string;
  type: string;
  score: number;
  kind: 'seed' | 'expansion';
  /** Set on an expansion hit. */
  expandedFrom?: unknown;
  /** Returned when the request named no `row` fields. */
  salience?: number;
  blendedScore?: number;
  row: RecallHitRow;
}

export type ScriptRecallHit = RecallHit;

/** What a script's default export receives. */
export interface ScriptContext {
  readonly kid: string | null;
  readonly mode: ScriptMode;
  /** The caller's `--args` object; `{}` when none was passed. */
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * One query. Throws when a requested key is missing from `data`, which is a
   * rejected frame, not an empty result.
   */
  query(frame: QualifiedFrame): Promise<PackEnvelope>;
  /** Every row of a single-key query, paging until `hasMore` is false. */
  queryAll(
    key: string,
    frame: { params?: Record<string, unknown>; fields?: unknown }
  ): Promise<Record<string, unknown>[]>;
  /**
   * The rows with these shortIds, through `where: { shortId: { eq | in } }`.
   * One number gives one row; an array gives the rows in input order. Throws
   * naming every shortId with no row. `fields` gains `shortId` when given.
   */
  byShortId(
    key: string,
    n: number,
    fields?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  byShortId(
    key: string,
    n: readonly number[],
    fields?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]>;
  /** Recall hits, best first, through the `recall/Hit` frame. */
  recall(input: ScriptRecallInput): Promise<ScriptRecallHit[]>;
  /**
   * The federated schema, one namespace's schema, or one type's. Throws naming
   * an unknown namespace or type.
   */
  schema(namespace?: string, type?: string): Promise<unknown>;
  /**
   * One mutate payload (one transaction). Returns null in `dry-run`, and throws
   * in `read`, past `maxWrites`, or when the server refuses any frame.
   */
  mutate(frame: QualifiedFrame): Promise<PackEnvelope | null>;
  /** Writes to stderr; stdout carries only the result. */
  log(...args: unknown[]): void;
}

export interface ScriptReport {
  ok: boolean;
  kid: string | null;
  mode: ScriptMode;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  mutations: ScriptMutation[];
  warnings: string[];
  stats: { queries: number; writes: number; ms: number };
}

export interface RunScriptOptions {
  client: SubstrateClient;
  kid: string | null;
  mode?: ScriptMode;
  args?: Record<string, unknown>;
  maxWrites?: number;
  maxPages?: number;
  log?: (line: string) => void;
}

export const DEFAULT_MAX_WRITES = 50;
const DEFAULT_MAX_PAGES = 200;

/** Counts the frames in a mutate payload: an array under an op-key is one frame per element. */
function frameCount(frame: QualifiedFrame): number {
  return Object.values(frame).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
}

function assertKeys(frame: QualifiedFrame, env: PackEnvelope, verb: string): void {
  const missing = Object.keys(frame).filter((k) => !(k in env.data));
  if (missing.length > 0 || (verb === 'mutate' && (env.errors?.length ?? 0) > 0)) {
    const errs = (env.errors ?? []).map((e) => `${e.code ?? 'error'}: ${e.message}`).join('; ');
    throw new Error(
      `${verb} refused${missing.length > 0 ? ` for ${missing.join(', ')}` : ''}${errs !== '' ? ` (${errs})` : ''}`
    );
  }
}

/**
 * Runs `script` against a guarded context and reports everything it did,
 * including the mutations applied before any failure.
 */
export async function runScript(
  script: (s: ScriptContext) => unknown,
  opts: RunScriptOptions
): Promise<ScriptReport> {
  const {
    client,
    kid,
    mode = 'read',
    args = {},
    maxWrites = DEFAULT_MAX_WRITES,
    maxPages = DEFAULT_MAX_PAGES
  } = opts;
  const log = opts.log ?? ((line: string) => console.error(line));
  const mutations: ScriptMutation[] = [];
  const warnings: string[] = [];
  const stats = { queries: 0, writes: 0, ms: 0 };
  const started = Date.now();

  const query = async (frame: QualifiedFrame): Promise<PackEnvelope> => {
    stats.queries++;
    const env = await client.query(frame);
    assertKeys(frame, env, 'query');
    for (const [key, page] of Object.entries(env._pagination ?? {})) {
      if (page.hasMore)
        warnings.push(`${key}: result truncated (hasMore); use queryAll for a complete read`);
    }
    return env;
  };

  async function queryAll(
    key: string,
    frame: { params?: Record<string, unknown>; fields?: unknown }
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params = { ...frame.params, ...(cursor !== undefined ? { cursor } : {}) };
      stats.queries++;
      const env = await client.query({ [key]: { ...frame, params } } as QualifiedFrame);
      assertKeys({ [key]: frame } as QualifiedFrame, env, 'query');
      const data = env.data[key];
      rows.push(...((Array.isArray(data) ? data : [data]) as Record<string, unknown>[]));
      const p = env._pagination?.[key];
      if (p?.hasMore !== true) return rows;
      if (p.nextCursor === undefined) throw new Error(`${key}: hasMore with no nextCursor`);
      cursor = p.nextCursor;
    }
    throw new Error(`${key}: still hasMore after ${maxPages} pages`);
  }

  async function byShortId(
    key: string,
    n: number | readonly number[],
    fields?: Record<string, unknown>
  ): Promise<Record<string, unknown> | Record<string, unknown>[]> {
    const wanted = Array.isArray(n) ? n : [n];
    if (wanted.length === 0) return [];
    const unique = [...new Set(wanted)];
    const rows = await queryAll(key, {
      params: {
        where: { shortId: unique.length === 1 ? { eq: unique[0] } : { in: unique } }
      },
      ...(fields !== undefined ? { fields: { ...fields, shortId: true } } : {})
    });
    const byId = new Map(rows.map((r) => [Number(r.shortId), r]));
    const missing = unique.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`${key}: no row with shortId ${missing.join(', ')}`);
    const found = wanted.map((id) => byId.get(id) as Record<string, unknown>);
    return Array.isArray(n) ? found : (found[0] as Record<string, unknown>);
  }

  const ctx: ScriptContext = {
    kid,
    mode,
    args: Object.freeze({ ...args }),
    query,
    queryAll,
    byShortId: byShortId as ScriptContext['byShortId'],
    async recall({ query: to, row, ...params }) {
      // The frame drops `row` unless `fields` names it, so the handle default sends no `fields`.
      const fields =
        row === undefined
          ? {}
          : {
              fields: {
                id: true,
                namespace: true,
                type: true,
                score: true,
                kind: true,
                expandedFrom: true,
                row
              }
            };
      const env = await query({
        'recall/Hit': { params: { to, ...params }, ...fields }
      } as QualifiedFrame);
      return env.data['recall/Hit'] as ScriptRecallHit[];
    },
    async schema(namespace, type) {
      const all = await client.federatedSchema();
      if (namespace === undefined) return all;
      const ns = all[namespace];
      if (ns === undefined) throw new Error(`schema: unknown namespace '${namespace}'`);
      if (type === undefined) return ns;
      const t = ns.types[type];
      if (t === undefined) throw new Error(`schema: unknown type '${namespace}/${type}'`);
      return t;
    },
    async mutate(frame) {
      if (mode === 'read')
        throw new Error('mutate refused: read mode (run in dry-run or write mode)');
      if (mode === 'dry-run') {
        mutations.push({ frame, applied: false });
        return null;
      }
      const n = frameCount(frame);
      if (stats.writes + n > maxWrites) {
        throw new Error(
          `mutate refused: ${stats.writes + n} frames would exceed --max-writes ${maxWrites}`
        );
      }
      const env = await client.mutate(frame);
      const applied = Object.keys(frame).some((k) => k in env.data);
      if (applied) stats.writes += n;
      mutations.push({
        frame,
        applied,
        ...(env.errors !== undefined ? { errors: env.errors } : {})
      });
      assertKeys(frame, env, 'mutate');
      return env;
    },
    log: (...args) =>
      log(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  };

  const report = (extra: { ok: boolean; result?: unknown; error?: string }): ScriptReport => {
    stats.ms = Date.now() - started;
    return { ...extra, kid, mode, args, mutations, warnings, stats };
  };
  try {
    return report({ ok: true, result: await script(ctx) });
  } catch (err) {
    return report({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
