/**
 * The index advisor's pass: from the read shapes the engine recorded and the
 * store's own statistics, write `_system/IndexRecommendation` rows. It builds
 * and drops nothing; a recommendation is applied only by a signed approval.
 *
 * - `add`: a shape is slow (p95 ≥ the profile's `slowP95Ms`) on a type with
 *   enough live rows, and no index the engine wants serves it.
 * - `remove`: an engine-owned, non-unique index the engine no longer wants
 *   (an old default, a retracted declaration) has had no scans for the
 *   profile's window on a type with real write volume. Never a `_base` or
 *   unique index, never one still wanted, so remove and reconcile cannot flap.
 *
 * A type `typeStats` does not report is unknown, never empty: no
 * recommendation is made for it.
 */

import { createHash } from 'node:crypto';
import {
  getExtensionOperator,
  type ReadShape,
  type ShapeRecorder,
  shapeKey
} from '@mnmal-ai/substrate-core';
import type {
  ActorIdentity,
  Dataset,
  FieldDef,
  IndexDecl,
  IndexPlan,
  Registry,
  Row,
  TypeStats
} from '@mnmal-ai/substrate-types';
import {
  INDEX_RECOMMENDATION_TYPE,
  STORE_PROFILE_ID,
  STORE_PROFILE_TYPE
} from '../_system/types.js';
import {
  isStoreProfileName,
  PROFILES,
  type ProfileThresholds,
  type StoreProfileName
} from './profiles.js';

const ADVISOR: ActorIdentity = { kind: 'system', id: 'index-advisor' };

/** What the advisor carries from one pass to the next. */
export interface AdvisorMemory {
  lastPassAt?: number;
  /** Per type: its insert count when first seen, for the write rate. */
  inserts: Map<string, { total: number; at: number }>;
  /** Per index: its scan count, and since when it has stood there. */
  scans: Map<string, { scans: number; since: number }>;
}

export const createAdvisorMemory = (): AdvisorMemory => ({ inserts: new Map(), scans: new Map() });

export interface AdvisorDeps {
  /** The store: `typeStats` and `indexPlan` span every namespace. */
  dataset: Dataset;
  /** The `_system` dataset, where the profile and the recommendations live. */
  system: Dataset;
  recorder: Pick<ShapeRecorder, 'drain'>;
  /** Each namespace's registry, for a type's declared fields. */
  registry: (namespace: string) => Registry | undefined;
  now: () => number;
  // shortcut: in-process, so a restart restarts every unused-index window and
  // write-rate baseline; persist them if restarts outpace `unusedWindowMs`.
  memory: AdvisorMemory;
}

const typeKey = (namespace: string, type: string): string => JSON.stringify([namespace, type]);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Whether `keys` lead with the equality fields (any order), then `order` in direction. */
function serves(
  keys: Array<[string, 'asc' | 'desc']>,
  eq: string[],
  order: Array<[string, 'asc' | 'desc']>
): boolean {
  const head = new Set(keys.slice(0, eq.length).map(([f]) => f));
  if (head.size !== eq.length || eq.some((f) => !head.has(f))) return false;
  return order.every(([f, d], i) => {
    const k = keys[eq.length + i];
    return k !== undefined && k[0] === f && k[1] === d;
  });
}

const indexable = (def: FieldDef | undefined): boolean =>
  def?.kind === 'crossRef' || (def?.kind === 'scalar' && def.type !== 'json');

function writeCost(rate: number | undefined, t: ProfileThresholds): 'low' | 'medium' | 'high' {
  if (rate === undefined || rate < t.minWriteRatePerMin) return 'low';
  return rate < 10 * t.minWriteRatePerMin ? 'medium' : 'high';
}

async function readProfile(system: Dataset): Promise<StoreProfileName> {
  const { rows } = await system.read(STORE_PROFILE_TYPE, { id: STORE_PROFILE_ID });
  const profile = rows[0]?.profile;
  return isStoreProfileName(profile) ? profile : 'personal';
}

/**
 * One row per `recKey`, which is also its id: inserted `open`, or, when it
 * exists, its evidence refreshed only while it is still `open`. Both steps are
 * atomic, so advisors on one store converge on one row and never reopen an
 * accepted or dismissed one.
 */
async function upsert(system: Dataset, row: Row & { id: string }, at: Date): Promise<boolean> {
  const inserted = await system.write(
    INDEX_RECOMMENDATION_TYPE,
    [{ ...row, recKey: row.id, state: 'open' }],
    { insertOnly: true, identity: ADVISOR, now: at }
  );
  if (inserted.ids.length > 0) return true;
  const { id, ...refresh } = row;
  const updated = await system.conditionalUpdate(
    INDEX_RECOMMENDATION_TYPE,
    id,
    { state: 'open' },
    refresh,
    ADVISOR,
    at
  );
  return updated.matched;
}

export async function runAdvisorPass(deps: AdvisorDeps): Promise<{ upserted: number }> {
  const { dataset, system, memory } = deps;
  const now = deps.now();
  const at = new Date(now);
  const shapes = deps.recorder.drain();
  const windowMs = memory.lastPassAt === undefined ? null : now - memory.lastPassAt;
  memory.lastPassAt = now;
  if (dataset.typeStats === undefined || dataset.indexPlan === undefined) return { upserted: 0 };
  const t = PROFILES[await readProfile(system)];

  const stats = new Map<string, TypeStats>();
  const rates = new Map<string, number>();
  for (const s of await dataset.typeStats()) {
    const key = typeKey(s.namespace, s.type);
    stats.set(key, s);
    const base = memory.inserts.get(key);
    if (base === undefined || s.insertsTotal < base.total) {
      // First sight, or the counters were reset: the window starts now.
      memory.inserts.set(key, { total: s.insertsTotal, at: now });
    } else if (now > base.at) {
      rates.set(key, ((s.insertsTotal - base.total) * 60_000) / (now - base.at));
    }
  }
  const plans = new Map<string, Promise<IndexPlan | undefined>>();
  const planOf = (namespace: string, type: string): Promise<IndexPlan | undefined> => {
    const key = typeKey(namespace, type);
    let plan = plans.get(key);
    if (plan === undefined) {
      plan = (dataset.indexPlan as NonNullable<Dataset['indexPlan']>).call(
        dataset,
        type,
        namespace
      );
      plans.set(key, plan);
    }
    return plan;
  };

  let upserted = 0;
  for (const { shape, count, p95Ms } of shapes) {
    const rec = await addFor(shape, count, p95Ms);
    if (rec !== undefined && (await upsert(system, rec, at))) upserted++;
  }

  for (const [key, s] of stats) {
    const plan = await planOf(s.namespace, s.type);
    if (plan === undefined) continue;
    const desired = new Set(plan.indexes.map((i) => i.name));
    const rate = rates.get(key);
    for (const i of s.indexes) {
      if (!i.engineOwned || i.unique || desired.has(i.name) || i.name.endsWith('_base')) continue;
      const scanKey = `${key}\0${i.name}`;
      const seen = memory.scans.get(scanKey);
      if (seen === undefined || seen.scans !== i.scans) {
        memory.scans.set(scanKey, { scans: i.scans, since: now });
        continue;
      }
      if (now - seen.since < t.unusedWindowMs) continue;
      if (rate === undefined || rate < t.minWriteRatePerMin) continue;
      const rec: Row & { id: string } = {
        id: sha256(`remove${i.name}`),
        namespace: s.namespace,
        type: s.type,
        action: 'remove',
        shape: '',
        indexName: i.name,
        declarationJson: JSON.stringify({ drop: i.name }),
        evidenceJson: JSON.stringify({
          scans: i.scans,
          sizeBytes: i.sizeBytes,
          liveRows: s.liveRows,
          writeRatePerMin: rate,
          window: now - seen.since
        }),
        estimatedWriteCost: writeCost(rate, t)
      };
      if (await upsert(system, rec, at)) upserted++;
    }
  }
  return { upserted };

  async function addFor(
    shape: ReadShape,
    count: number,
    p95Ms: number
  ): Promise<(Row & { id: string }) | undefined> {
    if (p95Ms < t.slowP95Ms) return undefined;
    // An extension operator (semantic, …) is served by its own index, not a btree.
    if (shape.filters.some((f) => getExtensionOperator(f.op) !== undefined)) return undefined;
    const key = typeKey(shape.namespace, shape.type);
    const s = stats.get(key);
    if (s === undefined) return undefined;
    const plan = await planOf(shape.namespace, shape.type);
    if (plan === undefined) return undefined;
    const min = plan.expectedSize === 'large' ? t.minRowsLargeHint : t.minRows;
    if (s.liveRows < min) return undefined;
    const eq = [...new Set(shape.filters.filter((f) => f.op === 'eq').map((f) => f.field))];
    // Every btree ends with `id`, so a trailing `id` in the order is served whatever precedes it.
    const order = shape.orderBy.filter(([f], i, all) => !(f === 'id' && i === all.length - 1));
    if (plan.indexes.some((i) => serves(i.keys, eq, order))) return undefined;

    // An `indexes` entry names declared scalar or crossRef fields only: the
    // filter's that are, then the order's up to its first that is not (a
    // metadata column such as `createdAt`, which a derived index carries).
    const entry = deps.registry(shape.namespace)?.get(shape.type);
    const fields = entry?.kind === 'type' ? entry.fields : {};
    const declEq = eq.filter((f) => indexable(fields[f]));
    const stop = order.findIndex(([f]) => !indexable(fields[f]));
    const declOrder = stop === -1 ? order : order.slice(0, stop);
    if (declEq.length + declOrder.length === 0) return undefined;
    // A declaration an index already covers would add nothing.
    if (plan.indexes.some((i) => serves(i.keys, declEq, declOrder))) return undefined;
    const declaration: IndexDecl = {
      fields: [...declEq, ...declOrder.map(([field, dir]) => ({ field, dir }))]
    };
    const rate = rates.get(key);
    const sk = shapeKey(shape);
    return {
      id: sha256(`add${sk}`),
      namespace: shape.namespace,
      type: shape.type,
      action: 'add',
      shape: sk,
      indexName: null,
      declarationJson: JSON.stringify(declaration),
      evidenceJson: JSON.stringify({
        count,
        p95Ms,
        liveRows: s.liveRows,
        writeRatePerMin: rate ?? null,
        window: windowMs
      }),
      estimatedWriteCost: writeCost(rate, t)
    };
  }
}
