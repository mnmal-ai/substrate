/**
 * Post-read application of extension-operator results. Spec §5.2.
 *
 * The dataset read() path pre-resolves extension operators into an `id IN [...]`
 * predicate and captures an {@link ExtensionOpResultMeta} side-channel (relevance
 * order + per-id computed score/vector). After the structural filter, sort,
 * cursor, and limit slice have produced the final page, this helper re-imposes
 * the operator's relevance order and stitches the requested computed fields onto
 * the page rows.
 *
 * Two behaviours:
 *  1. Relevance ordering — when the frame supplied NO explicit orderBy, rows
 *     reorder to the operator's hit order (best first). Rows absent from the hit
 *     list — e.g. matched via an OR branch alongside the operator — append after,
 *     keeping their incoming dataset order. An explicit orderBy WINS: no reorder.
 *  2. Computed-field stitching — `_score` / `_vector` copied onto shallow row
 *     copies iff the projection requested them (`fields._score === true` /
 *     `fields._vector === true`). A hit without a vector yields no `_vector` key.
 *
 * Pure; never mutates input rows (stitching works on shallow copies). Duplicate
 * ids in `orderedIds` rank by first occurrence (the rank map skips ids already
 * seen). Relevance order is page-local: cursor pagination across a semantic
 * filter keeps dataset order between pages.
 */

import type { ReadParams, Row } from '@mnmal-ai/substrate-types';
import type { ExtensionOpResultMeta } from './pre-resolve-extension-operators.js';

export interface ApplyExtensionMetaOpts {
  hasExplicitOrderBy: boolean;
  fields: ReadParams['fields'];
}

export function fieldRequested(fields: ReadParams['fields'], name: string): boolean {
  return fields !== undefined && fields[name] === true;
}

export function applyExtensionResultMeta(
  rows: ReadonlyArray<Row>,
  meta: ExtensionOpResultMeta,
  opts: ApplyExtensionMetaOpts
): Row[] {
  // Rank map: id → relevance position. First occurrence wins (dedups duplicate
  // ids in orderedIds naturally).
  const rank = new Map<string, number>();
  for (const id of meta.orderedIds) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }

  // 1. Relevance ordering — only when the caller gave no explicit orderBy.
  let ordered: Row[];
  if (opts.hasExplicitOrderBy) {
    ordered = rows.slice();
  } else {
    const inHits: Row[] = [];
    const rest: Row[] = [];
    for (const row of rows) {
      const r = typeof row.id === 'string' ? rank.get(row.id) : undefined;
      if (r !== undefined) inHits.push(row);
      else rest.push(row);
    }
    // Stable sort by rank; rows share a rank only via duplicate orderedIds,
    // where insertion order (Array.prototype.sort is stable) keeps them adjacent.
    inHits.sort((a, b) => {
      const ra = rank.get(a.id as string) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.id as string) ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
    ordered = [...inHits, ...rest];
  }

  // 2. Computed-field stitching — only the requested keys, via shallow copies.
  const wantScore = fieldRequested(opts.fields, '_score');
  const wantVector = fieldRequested(opts.fields, '_vector');
  if (!wantScore && !wantVector) return ordered;

  return ordered.map((row) => {
    const computed = typeof row.id === 'string' ? meta.computed.get(row.id) : undefined;
    if (computed === undefined) return row;
    return {
      ...row,
      ...(wantScore ? { _score: computed.score } : {}),
      ...(wantVector && computed.vector !== undefined ? { _vector: computed.vector } : {})
    };
  });
}
