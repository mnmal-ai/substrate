/**
 * Shapes a resolver return into the envelope.
 *
 * Discriminates single/list/null/ReadResult on the value itself, because the
 * registry entry doesn't carry arity. A stream-shaped return (§5.5) is an
 * error here: the one-shot envelope has no chunk channel.
 */

import type {
  FrameEntry,
  PackEnvelope,
  PolicyDecision,
  ReadResult,
  RequestContext,
  Row
} from '@mnmal-ai/substrate-types';
import { applyObligations } from '../policy-evaluator.js';
import { sealCursor } from './cursor-seal.js';
import { addError, isAsyncIterable, isReadResult } from './internals.js';

/**
 * Version-agnostic UUID shape gate for id-miss observability. A well-formed
 * UUID that misses on an id-based get/update suggests a dropped read/write;
 * short-form numeric ids legitimately miss and are excluded.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShapeResultInput {
  envelope: PackEnvelope;
  key: string;
  entry: FrameEntry;
  ctx: RequestContext;
  decision: PolicyDecision;
  result: Row | Row[] | ReadResult | AsyncIterable<Row> | null;
  metric(name: string, payload?: unknown): void;
}

export function shapeResult(input: ShapeResultInput): void {
  const { envelope, key, entry, ctx, decision, result, metric } = input;

  if (isAsyncIterable<Row>(result)) {
    addError(
      envelope,
      [key],
      `resolver for '${key}' returned an async iterable; use engine.stream instead`,
      'streamable_on_oneshot'
    );
    metric('engine_streamable_on_oneshot', { key });
    return;
  }

  if (isReadResult(result)) {
    // Paged list. Pull pagination metadata into envelope._pagination; apply
    // row-filter obligations to the rows only.
    const filtered = applyObligations(decision, result.rows, ctx);
    envelope.data[key] = filtered;
    envelope.shapes[key] = 'list';
    // shortcut: hasMore and nextCursor come from the unfiltered read, so row()
    // hides a row's values but not whether matching rows exist; upgrade by
    // compiling row policies into the read's where.
    const pg: { nextCursor?: string; hasMore: boolean } = {
      hasMore: result.hasMore
    };
    if (result.nextCursor !== undefined) {
      // The cursor names the page's last row as read, which a row filter may
      // have just hidden: seal it rather than hand that row's values out.
      const filtering = (decision.obligations?.length ?? 0) > 0;
      pg.nextCursor = filtering ? sealCursor(result.nextCursor) : result.nextCursor;
    }
    const paginationMap = envelope._pagination ?? {};
    paginationMap[key] = pg;
    envelope._pagination = paginationMap;
    return;
  }

  if (Array.isArray(result)) {
    const filtered = applyObligations(decision, result, ctx);
    envelope.data[key] = filtered;
    envelope.shapes[key] = 'list';
  } else if (result === null) {
    envelope.data[key] = null;
    envelope.shapes[key] = 'single';
    // A null for a well-formed UUID on get/update is likely a dropped
    // read/write; emit a metric. The null contract to the caller is unchanged.
    if (ctx.verb === 'update' || ctx.verb === 'get') {
      const idParam = entry.params?.id;
      if (typeof idParam === 'string' && UUID_RE.test(idParam)) {
        metric('engine_id_miss', { key, verb: ctx.verb, id: idParam });
      }
    }
  } else {
    // Single-row obligations: wrap in a list to run the filter, then pick
    // the first. Row-scoped denies on singles surface as a dropped row,
    // which matches the collection semantics ("silent drop").
    const filtered = applyObligations(decision, [result], ctx);
    envelope.data[key] = filtered[0] ?? null;
    envelope.shapes[key] = 'single';
  }
}
