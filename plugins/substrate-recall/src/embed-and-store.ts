/**
 * embedAndStore — generic write-path embedding primitive for plugin authors.
 *
 *   - Skips rows whose `id` is not a string.
 *   - Embeds the source text even when it is empty; only the null sentinel
 *     from `serializeRow` skips.
 *   - Swallows ALL errors: the write has already committed, so the mutation
 *     must succeed regardless. Logs to stderr and records a stats failure.
 */
import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { EmbedSourceContext, PostWriteHook, Row } from '@mnmal-ai/substrate-types';
import type { EmbedStats } from './embed-stats.js';
import type { EmbeddingsStore } from './embeddings-store.js';

const LOG_PREFIX = 'substrate-recall.embed:';

export interface EmbedAndStoreOptions {
  namespace: string;
  type: string;
  /**
   * Optional custom serializer returning the source text to embed (sync or
   * async), or `null` / `undefined` to declare the row un-indexable.
   *
   * The null sentinel is distinct from `''`: an empty string still embeds,
   * whereas the sentinel embeds nothing and removes any existing embedding.
   *
   * When omitted, the source text joins the non-empty string values of
   * `fields` with `'\n'`; if both are omitted it is `''`.
   */
  serializeRow?: (
    row: Record<string, unknown>
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Field names whose string values are joined with `'\n'` to build the
   * source text. Used only when `serializeRow` is not provided. Non-string
   * and empty values are filtered before joining.
   */
  fields?: string[];
  embedder: Embedder;
  store: EmbeddingsStore;
  stats?: EmbedStats;
}

/**
 * What became of one row's embedding attempt. Backfills report this; the
 * write path (`embedAndStore`) swallows it.
 */
export type EmbedOutcome =
  | { status: 'embedded' }
  /** Source returned the null sentinel — any existing vector was deleted. */
  | { status: 'unindexable' }
  /** Row carried no string or number `id`; nothing was attempted. */
  | { status: 'no-id' }
  /** `code` is the `EmbedError` code when the embedder raised one. */
  | { status: 'failed'; error: string; code?: 'unavailable' | 'invalid_response' };

/**
 * Embed one row and return what happened, without touching stats or stderr.
 * Never throws: failures come back as `{ status: 'failed' }`.
 */
export async function embedRowReporting(
  row: Record<string, unknown>,
  opts: EmbedAndStoreOptions
): Promise<EmbedOutcome> {
  const id =
    typeof row.id === 'string' ? row.id : typeof row.id === 'number' ? String(row.id) : null;
  if (id === null) return { status: 'no-id' };
  // Stamped before the (slow) embed: if two writes race, the store keeps the
  // vector of the later write, whichever embed finishes last.
  const now = new Date();

  try {
    let source: string | null | undefined;
    if (opts.serializeRow) {
      // await covers both sync and async serializers.
      source = await opts.serializeRow(row);
    } else if (opts.fields && opts.fields.length > 0) {
      source = opts.fields
        .map((f) => row[f])
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join('\n');
    } else {
      source = '';
    }

    if (source === null || source === undefined) {
      // Delete any existing vector too: rows can become un-indexable after
      // they were first embedded.
      await opts.store.delete({
        rowNamespace: opts.namespace,
        rowType: opts.type,
        rowId: id
      });
      return { status: 'unindexable' };
    }

    const vector = await opts.embedder.embed(source);
    await opts.store.upsert({
      rowNamespace: opts.namespace,
      rowType: opts.type,
      rowId: id,
      vector,
      model: opts.embedder.modelId,
      now
    });
    return { status: 'embedded' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = embedErrorCode(err);
    return code === undefined ? { status: 'failed', error } : { status: 'failed', error, code };
  }
}

/**
 * The code of an `EmbedError`, matched by name rather than `instanceof` so a
 * second copy of substrate-embedder in the tree still matches.
 */
function embedErrorCode(err: unknown): 'unavailable' | 'invalid_response' | undefined {
  if (!(err instanceof Error) || err.name !== 'EmbedError') return undefined;
  const code = (err as { code?: unknown }).code;
  return code === 'unavailable' || code === 'invalid_response' ? code : undefined;
}

export async function embedAndStore(
  row: Record<string, unknown>,
  opts: EmbedAndStoreOptions
): Promise<void> {
  const outcome = await embedRowReporting(row, opts);
  switch (outcome.status) {
    case 'embedded':
      opts.stats?.recordSuccess();
      return;
    case 'unindexable':
      opts.stats?.recordSkip();
      return;
    case 'no-id':
      return;
    case 'failed': {
      // Swallow: the write has already committed and the mutation must
      // succeed. Log + count so operators can diagnose.
      const id = typeof row.id === 'string' ? row.id : '<no-id>';
      process.stderr.write(
        `${LOG_PREFIX} failed to embed ${opts.type} id=${id}: ${outcome.error}\n`
      );
      opts.stats?.recordFailure(id, outcome.error);
      return;
    }
  }
}

export interface EmbedBinding {
  namespace: string;
  type: string;
  source: (
    row: Row,
    ctx?: EmbedSourceContext
  ) => string | null | undefined | Promise<string | null | undefined>;
  embedder: Embedder;
  store: EmbeddingsStore;
  stats?: EmbedStats;
  /** Optional context passed to `source(row, ctx)`; `undefined` when omitted. */
  embedSourceContext?: EmbedSourceContext;
}

function bindingToOptions(args: EmbedBinding): EmbedAndStoreOptions {
  const ctx = args.embedSourceContext;
  return {
    namespace: args.namespace,
    type: args.type,
    serializeRow: (r) => args.source(r as Row, ctx),
    embedder: args.embedder,
    store: args.store,
    ...(args.stats !== undefined ? { stats: args.stats } : {})
  };
}

/**
 * Wrap `embedAndStore` into a PostWriteHook that embeds every successfully
 * written row. Never throws, so it cannot break the postWrite chain.
 */
export function makeEmbedPostWrite(args: EmbedBinding): PostWriteHook {
  return async (row, _ctx) => {
    await embedAndStore(row as Record<string, unknown>, bindingToOptions(args));
  };
}

/**
 * Returns a re-embed function built from the same binding as
 * `makeEmbedPostWrite`, so a backfill writes the same vector the write path
 * would. Reports each outcome instead of swallowing errors.
 */
export function makeReembed(args: EmbedBinding): (row: Row) => Promise<EmbedOutcome> {
  return async (row) => embedRowReporting(row as Record<string, unknown>, bindingToOptions(args));
}
