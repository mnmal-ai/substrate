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

/**
 * The advisor's baseline, persisted on the `StoreProfile` row so a restart,
 * or another advisor process on the store, picks it up. Times are epoch ms.
 */
export interface AdvisorState {
  /** When the advisor first observed this store. */
  epoch: number;
  lastPassAt?: number;
  /** Per type (`typeKey`): its write counters when the rate's window opened. */
  types: Record<string, { ins: number; upd: number; del: number; at: number }>;
  /** Per engine index (`typeKey` + NUL + name): when the advisor first saw it. */
  indexes: Record<string, number>;
}

async function readState(
  system: Dataset
): Promise<{ profile: StoreProfileName; state: AdvisorState | undefined }> {
  const { rows } = await system.read(STORE_PROFILE_TYPE, { id: STORE_PROFILE_ID });
  const row = rows[0];
  const profile = isStoreProfileName(row?.profile) ? row.profile : 'personal';
  try {
    const state = JSON.parse(String(row?.advisorStateJson ?? 'null')) as AdvisorState | null;
    return { profile, state: state ?? undefined };
  } catch {
    return { profile, state: undefined };
  }
}

export interface AdvisorDeps {
  /** The store: `typeStats` and `indexPlan` span every namespace. */
  dataset: Dataset;
  /** The `_system` dataset, where the profile and the recommendations live. */
  system: Dataset;
  recorder: Pick<ShapeRecorder, 'drain'>;
  /** Each namespace's registry, for a type's declared fields. */
  registry: (namespace: string) => Registry | undefined;
  now: () => number;
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

/** What an `indexes` entry may key on: a declared scalar or crossRef, or a metadata column. */
const declarable = (field: string, def: FieldDef | undefined): boolean =>
  field === 'createdAt' ||
  field === 'updatedAt' ||
  def?.kind === 'crossRef' ||
  (def?.kind === 'scalar' && def.type !== 'json');

/** The shape a `shapeKey` names, or undefined when it does not parse. */
function shapeOf(key: string): ReadShape | undefined {
  try {
    const [namespace, type, filters, orderBy] = JSON.parse(key) as [
      string,
      string,
      string[],
      ReadShape['orderBy']
    ];
    return {
      namespace,
      type,
      filters: filters.map((f) => {
        const at = f.lastIndexOf(' ');
        return { field: f.slice(0, at), op: f.slice(at + 1) };
      }),
      orderBy
    };
  } catch {
    return undefined;
  }
}

/** The equality fields and the order (less a trailing `id`) an index must lead with. */
function servedBy(shape: ReadShape): { eq: string[]; order: ReadShape['orderBy'] } {
  const eq = [...new Set(shape.filters.filter((f) => f.op === 'eq').map((f) => f.field))];
  // Every btree ends with `id`, so a trailing `id` in the order is served whatever precedes it.
  const order = shape.orderBy.filter(([f], i, all) => !(f === 'id' && i === all.length - 1));
  return { eq, order };
}

function writeCost(rate: number | undefined, t: ProfileThresholds): 'low' | 'medium' | 'high' {
  if (rate === undefined || rate < t.minWriteRatePerMin) return 'low';
  return rate < 10 * t.minWriteRatePerMin ? 'medium' : 'high';
}

/**
 * One row per `recKey`, which is also its id: inserted `open`; or, when it
 * exists, its evidence refreshed while `open`, or reopened when `superseded`
 * (the evidence is back). Each step is atomic, so advisors on one store
 * converge on one row and never reopen an accepted or dismissed one.
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
  if (updated.matched) return true;
  const reopened = await system.conditionalUpdate(
    INDEX_RECOMMENDATION_TYPE,
    id,
    { state: 'superseded' },
    { ...refresh, state: 'open' },
    ADVISOR,
    at
  );
  return reopened.matched;
}

export async function runAdvisorPass(deps: AdvisorDeps): Promise<{ upserted: number }> {
  const { dataset, system } = deps;
  const now = deps.now();
  const at = new Date(now);
  const shapes = deps.recorder.drain();
  if (dataset.typeStats === undefined || dataset.indexPlan === undefined) return { upserted: 0 };
  const read = await readState(system);
  const t = PROFILES[read.profile];
  const prior = read.state;
  const windowMs = prior?.lastPassAt === undefined ? null : now - prior.lastPassAt;
  const state: AdvisorState = {
    epoch: prior?.epoch ?? now,
    lastPassAt: now,
    types: { ...prior?.types },
    indexes: {}
  };

  const stats = new Map<string, TypeStats>();
  // Writes per minute since the type's baseline. A counter below its baseline
  // (a stats reset, a pg restart, a failover) re-baselines the type to now,
  // and its rate is skipped this pass.
  const rates = new Map<string, number>();
  for (const s of await dataset.typeStats()) {
    const key = typeKey(s.namespace, s.type);
    stats.set(key, s);
    const cur = { ins: s.insertsTotal, upd: s.updatesTotal, del: s.deletesTotal, at: now };
    const base = state.types[key];
    if (base === undefined || cur.ins < base.ins || cur.upd < base.upd || cur.del < base.del) {
      state.types[key] = cur;
    } else if (now > base.at) {
      const writes = cur.ins - base.ins + (cur.upd - base.upd) + (cur.del - base.del);
      rates.set(key, (writes * 60_000) / (now - base.at));
    }
  }
  // Index first sightings: kept for every engine index still held and for
  // every type `typeStats` did not report (unknown, not gone); a dropped
  // index's entry goes, so one rebuilt under its name starts a new age.
  for (const [k, seen] of Object.entries(prior?.indexes ?? {})) {
    if (!stats.has(k.slice(0, k.indexOf('\0')))) state.indexes[k] = seen;
  }
  for (const [key, s] of stats) {
    for (const i of s.indexes) {
      if (!i.engineOwned) continue;
      const k = `${key}\0${i.name}`;
      state.indexes[k] = prior?.indexes[k] ?? now;
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
      // Unused: no scan within the window, and known to have existed for all
      // of it. pg records no index creation time, so its age is counted from
      // when the advisor first saw it.
      const since = state.indexes[`${key}\0${i.name}`] ?? now;
      const lastScan = i.lastScanAt === null ? undefined : Date.parse(i.lastScanAt);
      if (lastScan !== undefined && now - lastScan < t.unusedWindowMs) continue;
      if (now - since < t.unusedWindowMs) continue;
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
          lastScanAt: i.lastScanAt,
          sizeBytes: i.sizeBytes,
          liveRows: s.liveRows,
          writeRatePerMin: rate,
          window: t.unusedWindowMs
        }),
        estimatedWriteCost: writeCost(rate, t)
      };
      if (await upsert(system, rec, at)) upserted++;
    }
  }
  await supersede();
  // Last write wins between two advisors on one store, which is safe: a
  // baseline only moves forward or re-baselines, and either keeps rates and
  // ages conservative. A merge write, so the profile beside it is untouched.
  await system.write(
    STORE_PROFILE_TYPE,
    [{ id: STORE_PROFILE_ID, advisorStateJson: JSON.stringify(state) }],
    { identity: ADVISOR, now: at }
  );
  return { upserted };

  /** Open recommendations the store no longer needs: a shape now served, an index gone or wanted again. */
  async function supersede(): Promise<void> {
    const { rows } = await system.read(INDEX_RECOMMENDATION_TYPE, {
      where: { state: { eq: 'open' } }
    });
    for (const row of rows) {
      const namespace = String(row.namespace);
      const type = String(row.type);
      const s = stats.get(typeKey(namespace, type));
      // Unknown types are left as they are.
      const plan = s === undefined ? undefined : await planOf(namespace, type);
      if (s === undefined || plan === undefined) continue;
      let done = false;
      if (row.action === 'add') {
        const shape = shapeOf(String(row.shape));
        if (shape === undefined) continue;
        const { eq, order } = servedBy(shape);
        done = plan.indexes.some((i) => serves(i.keys, eq, order));
      } else if (row.action === 'remove') {
        const name = String(row.indexName);
        done = !s.indexes.some((i) => i.name === name) || plan.indexes.some((i) => i.name === name);
      }
      if (done) {
        await system.conditionalUpdate(
          INDEX_RECOMMENDATION_TYPE,
          row.id,
          { state: 'open' },
          { state: 'superseded' },
          ADVISOR,
          at
        );
      }
    }
  }

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
    const { eq, order } = servedBy(shape);
    if (plan.indexes.some((i) => serves(i.keys, eq, order))) return undefined;

    // An `indexes` entry keys on what `declarable` allows: the filter's
    // fields that qualify, then the order's up to its first that does not.
    const entry = deps.registry(shape.namespace)?.get(shape.type);
    const fields = entry?.kind === 'type' ? entry.fields : {};
    const declEq = eq.filter((f) => declarable(f, fields[f]));
    const stop = order.findIndex(([f]) => !declarable(f, fields[f]));
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
