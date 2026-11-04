/**
 * Every type a walk-grammar frame reads besides its seed (spec 2026-10-24-typed-edge-walks §2, §3):
 * each `_walk`, `_agg` and nested `{ _walk }` selection at any depth, with the
 * walk's own `where`. The engine evaluates each one's read policy before the
 * frame runs, so a walk can never read rows a top-level read could not.
 */

import { forEachWalkHop } from '@mnmal-ai/substrate-filter';
import type { TypeSchema, WhereClause } from '@mnmal-ai/substrate-types';
import { resolveHop } from './filter/walk-validator.js';

export interface WalkedType {
  type: string;
  where?: WhereClause;
  /**
   * True for an `all` or `pick` walk: those read far rows the walk's `where`
   * does not narrow (`all` reads the non-matching ones, `pick` chooses among
   * every neighbour), so their policy must judge an unfiltered read.
   */
  unfiltered?: true;
  /** Path inside the frame entry, e.g. `['where', '_walk']`. */
  path: string[];
}

/** The far type a hop node (`{ in }` or `{ out }`) reaches from `from`. Throws when it does not resolve. */
export type HopResolver = (node: Record<string, unknown>, from: string, path: string[]) => string;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `HopResolver` over one namespace's schema, sharing the validator's edge resolution. */
export function hopResolver(
  namespace: string,
  schemaOf: (type: string) => TypeSchema | undefined
): HopResolver {
  return (node, from, path) => {
    const fields = schemaOf(from)?.fields;
    if (!isObj(fields)) throw new Error(`unknown type '${namespace}/${from}'`);
    return resolveHop(node, path, {
      namespace,
      schemaOf,
      typeName: from,
      fields,
      depth: 0,
      bindings: new Map(),
      hidden: new Set(),
      underOrNot: false,
      groupBound: false
    }).typeName;
  };
}

/** Walked types of a frame entry `{ params, fields }` seeded at `seed`, deduplicated by (type, where, unfiltered). */
export function walkedTypes(
  entry: Record<string, unknown>,
  seed: string,
  resolve: HopResolver
): WalkedType[] {
  const out = new Map<string, WalkedType>();
  const hop = (node: Record<string, unknown>, from: string, path: string[], where = node.where) => {
    const type = resolve(node, from, path);
    const unfiltered = node.quantifier === 'all' || node.pick !== undefined;
    const k = JSON.stringify([type, where ?? null, unfiltered]);
    if (!out.has(k)) {
      out.set(k, {
        type,
        path,
        ...(where !== undefined ? { where: where as WhereClause } : {}),
        ...(unfiltered ? { unfiltered: true as const } : {})
      });
    }
    return type;
  };

  forEachWalkHop(entry, seed, ({ node, path, selection }, from) => {
    // A nested list's two wheres both filter the far rows, so the policy sees them together.
    const sel = selection?.sel;
    const where =
      sel === undefined
        ? node.where
        : node.where !== undefined && sel.where !== undefined
          ? { AND: [node.where, sel.where] }
          : (node.where ?? sel.where);
    return hop(node, from, path, where);
  });
  return [...out.values()];
}
