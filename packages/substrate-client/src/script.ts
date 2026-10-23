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
  type?: string;
  k?: number;
  threshold?: number;
  where?: Record<string, unknown>;
  /** `true` for the whole row, or the fields to return beside `id`. Omit for the handle fields. */
  row?: true | Record<string, true>;
}

export interface ScriptRecallHit {
  id: string;
  namespace: string;
  type: string;
  score: number;
  kind: 'seed' | 'expansion';
  expandedFrom?: unknown;
  row: Record<string, unknown>;
}

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
  /** Recall hits, best first, through the `recall/Hit` frame. */
  recall(input: ScriptRecallInput): Promise<ScriptRecallHit[]>;
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
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
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

  const ctx: ScriptContext = {
    kid,
    mode,
    args: Object.freeze({ ...args }),
    query,
    async queryAll(key, frame) {
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
    },
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
    async mutate(frame) {
      if (mode === 'read') throw new Error('mutate refused: read mode (pass --dry-run or --write)');
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
