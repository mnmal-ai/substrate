/** The surgery routes (spec §5), typed. Every call but `embedStats` (which needs only `read`) needs an identity whose grant confers admin. */

import type { HttpTransport } from '../transport/http.js';

export type AdminDropCascade = 'refuse' | 'delete';

export interface AdminDropNamespaceInput {
  readonly namespace: string;
  /** What the server checks against the namespace. The TUI sends the operator's typed target on apply. */
  readonly confirm: string;
  readonly cascade?: AdminDropCascade;
  readonly dryRun?: boolean;
}

export interface AdminDropTypeInput {
  readonly namespace: string;
  readonly type: string;
  /** Must equal `<namespace>/<type>` server-side. */
  readonly confirm: string;
  readonly cascade?: AdminDropCascade;
  readonly dryRun?: boolean;
}

export interface AdminDropResult {
  readonly namespace: string;
  /** Present for drop-type. */
  readonly type?: string;
  readonly dryRun: boolean;
  readonly cascade: AdminDropCascade;
  readonly rowsDeleted: number;
  readonly edgesDeleted: number;
  readonly shortIdsDeleted: number;
  /** Always minted, dry run included. On a dry run it names an audit row that was rolled back: never present it as a reference. */
  readonly auditEventId: string;
}

export interface AdminNormaliseInput {
  readonly namespace: string;
  readonly type: string;
  readonly field: string;
  readonly reject?: readonly string[];
  /** Omitted or false: a dry run. */
  readonly apply?: boolean;
}

export interface AdminNormaliseResult {
  readonly namespace: string;
  readonly type: string;
  readonly field: string;
  readonly strict: boolean;
  readonly scanned: number;
  /** The scan stopped at its row cap: every count below is partial. */
  readonly truncated: boolean;
  readonly plan: readonly { readonly from: string; readonly to: string; readonly count: number }[];
  /** Stored values no alias explains. */
  readonly unmapped: readonly { readonly value: string; readonly count: number }[];
  readonly applied: boolean;
  /** Present when applied: one entry per alias actually migrated. */
  readonly migrated?: readonly {
    readonly from: string;
    readonly to: string;
    readonly count: number;
  }[];
  /** Present when applied: stored values left stranded (rejected). */
  readonly stranded?: readonly { readonly value: string; readonly count: number }[];
}

/** Mirrors BACKFILL_MAX_ROWS in substrate-compose; the server enforces it. */
export const BACKFILL_CHUNK = 5000;

export interface AdminBackfillInput {
  readonly namespace: string;
  readonly type: string;
  readonly field: string;
  /** Row id → value. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Omitted or false: a dry run. */
  readonly apply?: boolean;
  /** Omitted or false: only empty values are filled. */
  readonly overwrite?: boolean;
}

export interface AdminBackfillSummary {
  readonly requested: number;
  readonly write: number;
  readonly kept: number;
  readonly unchanged: number;
  readonly missing: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly applied: boolean;
  /** How many requests the values took. More than one means an apply is not atomic. */
  readonly chunks: number;
}

export interface AdminBackfillChunk {
  readonly index: number;
  readonly chunks: number;
  /** The route's own response for this chunk, verbatim. */
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * A chunk was refused. `chunksDone` chunks were already sent (and, on apply, WRITTEN); `partial` sums them.
 *
 * `cause` is the real failure and may be an `AuthError` (a rejected admin key) or a
 * `NetworkError` (including one wrapping an `AbortError`). Callers must unwrap `cause`
 * before applying an auth-lock rule or abort handling.
 *
 * `partial.applied` true means at least one chunk was accepted and written; `chunksDone` says how
 * many. `false` does NOT prove nothing was written: a first chunk refused with anything but a 4xx
 * may have partly written (below). A refusal with a 4xx status guarantees the failing chunk wrote nothing;
 * anything else (a 5xx such as `verify_failed`, a dropped connection, an abort) may have
 * partly written the failing chunk, since the route writes in non-transactional 200-row batches.
 */
export class AdminBackfillError extends Error {
  override readonly name = 'AdminBackfillError';
  constructor(
    override readonly cause: unknown,
    readonly chunksDone: number,
    readonly chunks: number,
    readonly partial: AdminBackfillSummary
  ) {
    super(
      `backfill stopped at chunk ${chunksDone + 1} of ${chunks}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

export interface AdminReindexInput {
  readonly namespace: string;
  readonly type: string;
  readonly cursor?: string;
  /** Server default 100, max 1000. */
  readonly limit?: number;
}

export interface AdminReindexPage {
  readonly namespace: string;
  readonly type: string;
  readonly scanned: number;
  readonly embedded: number;
  readonly unindexable: number;
  readonly failed: number;
  readonly failures: readonly { readonly id: string; readonly error: string }[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface AdminEmbedStats {
  readonly enabled: boolean;
  /** Absent and `[]` are different answers: absent means the server did not say. Never collapse with `?? []`. */
  readonly embeddedTypes?: readonly { readonly namespace: string; readonly type: string }[];
  readonly writes?: number;
  readonly failures?: number;
}

export interface SurgeryApi {
  /** ONE page; the caller owns the loop so it can show progress and stop between pages. */
  reindexPage(input: AdminReindexInput, opts?: { signal?: AbortSignal }): Promise<AdminReindexPage>;
  embedStats(opts?: { signal?: AbortSignal }): Promise<AdminEmbedStats>;
  /** `onChunk` must not throw: a throw escapes without `chunksDone`/`partial`. */
  backfill(
    input: AdminBackfillInput,
    opts?: { signal?: AbortSignal; onChunk?: (chunk: AdminBackfillChunk) => void }
  ): Promise<AdminBackfillSummary>;
  dropNamespace(
    input: AdminDropNamespaceInput,
    opts?: { signal?: AbortSignal }
  ): Promise<AdminDropResult>;
  dropType(input: AdminDropTypeInput, opts?: { signal?: AbortSignal }): Promise<AdminDropResult>;
  normalise(
    input: AdminNormaliseInput,
    opts?: { signal?: AbortSignal }
  ): Promise<AdminNormaliseResult>;
}

type Opts = { signal?: AbortSignal; onChunk?: (chunk: AdminBackfillChunk) => void };
const sig = (o: Opts) => (o.signal !== undefined ? { signal: o.signal } : {});

export function createSurgeryApi(t: HttpTransport): SurgeryApi {
  const post = async <R>(path: string, body: Record<string, unknown>, o: Opts): Promise<R> =>
    (await (await t.raw(path, { method: 'POST', body, ...sig(o) })).json()) as R;
  return {
    async backfill(input, o = {}) {
      const entries = Object.entries(input.values);
      const chunks = Math.ceil(entries.length / BACKFILL_CHUNK);
      const apply = input.apply === true;
      let write = 0;
      let kept = 0;
      let unchanged = 0;
      const missing: string[] = [];
      const counts: Record<string, number> = {};
      const summary = (applied = apply): AdminBackfillSummary => ({
        requested: entries.length,
        write,
        kept,
        unchanged,
        missing: [...missing],
        counts: { ...counts },
        applied,
        chunks
      });
      for (let index = 0; index < chunks; index++) {
        const slice = entries.slice(index * BACKFILL_CHUNK, (index + 1) * BACKFILL_CHUNK);
        let body: Record<string, unknown>;
        try {
          body = await post(
            '/substrate/v1/_system/backfill-field',
            {
              namespace: input.namespace,
              type: input.type,
              field: input.field,
              apply,
              overwrite: input.overwrite === true,
              values: Object.fromEntries(slice)
            },
            o
          );
        } catch (err) {
          throw new AdminBackfillError(err, index, chunks, summary(apply && index > 0));
        }
        write += Number(body.write ?? 0);
        kept += Number(body.kept ?? 0);
        unchanged += Number(body.unchanged ?? 0);
        if (Array.isArray(body.missing)) missing.push(...(body.missing as string[]));
        for (const [k, n] of Object.entries((body.counts ?? {}) as Record<string, number>)) {
          counts[k] = (counts[k] ?? 0) + n;
        }
        o.onChunk?.({ index, chunks, body });
      }
      return summary();
    },
    reindexPage(input, o = {}) {
      const body: Record<string, unknown> = { namespace: input.namespace, type: input.type };
      if (input.cursor !== undefined) body.cursor = input.cursor;
      if (input.limit !== undefined) body.limit = input.limit;
      return post('/substrate/v1/embed/reindex', body, o);
    },
    async embedStats(o = {}) {
      return (await (
        await t.raw('/substrate/v1/embed-stats', { method: 'GET', ...sig(o) })
      ).json()) as AdminEmbedStats;
    },
    dropNamespace(input, o = {}) {
      const body: Record<string, unknown> = { namespace: input.namespace, confirm: input.confirm };
      if (input.cascade !== undefined) body.cascade = input.cascade;
      if (input.dryRun !== undefined) body.dryRun = input.dryRun;
      return post('/substrate/v1/_system/drop-namespace', body, o);
    },
    dropType(input, o = {}) {
      const body: Record<string, unknown> = {
        namespace: input.namespace,
        type: input.type,
        confirm: input.confirm
      };
      if (input.cascade !== undefined) body.cascade = input.cascade;
      if (input.dryRun !== undefined) body.dryRun = input.dryRun;
      return post('/substrate/v1/_system/drop-type', body, o);
    },
    normalise(input, o = {}) {
      const body: Record<string, unknown> = {
        namespace: input.namespace,
        type: input.type,
        field: input.field
      };
      if (input.reject !== undefined) body.reject = [...input.reject];
      if (input.apply === true) body.apply = true;
      return post('/substrate/v1/_system/normalise-vocab', body, o);
    }
  };
}
