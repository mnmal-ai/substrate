/**
 * The index advisor's pass: from the read shapes the engine recorded and the
 * store's own statistics, write `_system/IndexRecommendation` rows. It builds
 * and drops nothing; a recommendation is applied only by a signed approval.
 *
 * - `add`: a conjunctive shape read often enough (`minReads`) is slow (p95 ≥
 *   `slowP95Ms`) on a type with enough live rows, and no index that serves
 *   the type's reads serves it.
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
  ADVISOR_STATE_ID,
  ADVISOR_STATE_TYPE,
  INDEX_RECOMMENDATION_TYPE,
  STORE_PROFILE_ID,
  STORE_PROFILE_TYPE
} from '../_system/types.js';
import { isStoreProfileName, PROFILES, type ProfileThresholds } from './profiles.js';

const ADVISOR: ActorIdentity = { kind: 'system', id: 'index-advisor' };

/**
 * The advisor's baseline, persisted in `_system/AdvisorState` so a restart,
 * or another advisor process on the store, picks it up. Times are epoch ms.
 */
export interface AdvisorState {
  /** When the advisor first observed this store. */
  epoch: number;
  /** Per type (`typeKey`): its write counters when the rate's window opened. */
  types: Record<string, { ins: number; upd: number; del: number; at: number }>;
  /**
   * Per engine index (`typeKey` + NUL + name): when the advisor first saw it,
   * or saw pg's statistics restart; and its scan count and whether it had a
   * last scan then, which is how a restart is told.
   */
  indexes: Record<string, { seen: number; scans: number; scanned: boolean }>;
}

export interface AdvisorDeps {
  /** The store: `typeStats` and `indexPlan` span every namespace. */
  dataset: Dataset;
  /** The `_system` dataset, where the profile, the state and the recommendations live. */
  system: Dataset;
  recorder: Pick<ShapeRecorder, 'drain' | 'since'>;
  /** Each namespace's registry, for a type's declared fields. */
  registry: (namespace: string) => Registry | undefined;
  now: () => number;
  /** Halves the write rate a type needs before an unused index is worth removing. */
  writeHeavy?: boolean;
}

type PlanIndex = IndexPlan['indexes'][number];

const typeKey = (namespace: string, type: string): string => JSON.stringify([namespace, type]);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The parts of a shape an index must match: its equalities, boolean literals and order. */
interface Need {
  eq: string[];
  literals: Record<string, boolean | null>;
  order: ReadShape['orderBy'];
}

function needOf(shape: ReadShape): Need {
  const eq = [...new Set(shape.filters.filter((f) => f.op === 'eq').map((f) => f.field))];
  // Every btree ends with `id`, so a trailing `id` in the order is served whatever precedes it.
  const order = shape.orderBy.filter(([f], i, all) => !(f === 'id' && i === all.length - 1));
  return { eq, literals: shape.literals ?? {}, order };
}

/**
 * Whether `index` serves `need`: a partial index only when the read `eq`s
 * each predicate field to its value; then its keys lead with the remaining
 * equality fields (any order), followed by the order in direction.
 */
function serves(index: PlanIndex, need: Need): boolean {
  const only = Object.entries(index.only ?? {});
  if (only.some(([f, v]) => !Object.hasOwn(need.literals, f) || need.literals[f] !== v)) {
    return false;
  }
  const fixed = new Set(only.map(([f]) => f));
  const eq = need.eq.filter((f) => !fixed.has(f));
  const head = new Set(index.keys.slice(0, eq.length).map(([f]) => f));
  if (head.size !== eq.length || eq.some((f) => !head.has(f))) return false;
  return need.order.every(([f, d], i) => {
    const k = index.keys[eq.length + i];
    return k !== undefined && k[0] === f && k[1] === d;
  });
}

/**
 * Whether `plan` already serves the read shape `key` names (an `add`
 * recommendation's `shape`), as the advisor's supersede pass decides.
 * Undefined when the key does not parse.
 */
export function planServesShape(plan: IndexPlan, key: string): boolean | undefined {
  const shape = shapeOf(key);
  if (shape === undefined) return undefined;
  const need = needOf(shape);
  return plan.indexes.some((i) => serves(i, need));
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
    const [namespace, type, filters, orderBy, disjunctive, literals] = JSON.parse(key) as [
      string,
      string,
      string[],
      ReadShape['orderBy'],
      boolean | undefined,
      Array<[string, boolean | null]> | undefined
    ];
    return {
      namespace,
      type,
      filters: filters.map((f) => {
        const at = f.lastIndexOf(' ');
        return { field: f.slice(0, at), op: f.slice(at + 1) };
      }),
      orderBy,
      ...(disjunctive === true ? { disjunctive: true as const } : {}),
      ...(literals !== undefined && literals.length > 0
        ? { literals: Object.fromEntries(literals) }
        : {})
    };
  } catch {
    return undefined;
  }
}

function writeCost(rate: number | undefined, t: ProfileThresholds): 'low' | 'medium' | 'high' {
  if (rate === undefined || rate < t.minWriteRatePerMin) return 'low';
  return rate < 10 * t.minWriteRatePerMin ? 'medium' : 'high';
}

async function readState(system: Dataset): Promise<AdvisorState | undefined> {
  const { rows } = await system.read(ADVISOR_STATE_TYPE, { id: ADVISOR_STATE_ID });
  try {
    const state = JSON.parse(String(rows[0]?.stateJson ?? 'null')) as AdvisorState | null;
    return state ?? undefined;
  } catch {
    return undefined;
  }
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
  const { dataset, system, recorder } = deps;
  const now = deps.now();
  const at = new Date(now);
  // The shapes cover this process's reads since its recorder last drained.
  const windowMs = now - recorder.since;
  const shapes = recorder.drain();
  if (dataset.typeStats === undefined || dataset.indexPlan === undefined) return { upserted: 0 };
  const { rows: profiles } = await system.read(STORE_PROFILE_TYPE, { id: STORE_PROFILE_ID });
  const profile = profiles[0]?.profile;
  const base = PROFILES[isStoreProfileName(profile) ? profile : 'personal'];
  const t = deps.writeHeavy ? { ...base, minWriteRatePerMin: base.minWriteRatePerMin / 2 } : base;
  const prior = await readState(system);
  const state: AdvisorState = { epoch: prior?.epoch ?? now, types: {}, indexes: {} };

  const stats = new Map<string, TypeStats>();
  for (const s of await dataset.typeStats()) stats.set(typeKey(s.namespace, s.type), s);
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

  // Writes per minute since each type's baseline. pg's statistics restart on
  // a reset, a crash or a failover: a counter below its baseline, or an index
  // that had a last scan and has none, or fewer scans. Then the type is
  // re-baselined, its rate skipped, and its indexes' windows restarted, so no
  // `remove` rests on a scan history pg no longer has.
  const rates = new Map<string, number>();
  for (const [key, s] of stats) {
    const cur = { ins: s.insertsTotal, upd: s.updatesTotal, del: s.deletesTotal, at: now };
    const base = prior?.types[key];
    const seenOf = (name: string) => prior?.indexes[`${key}\0${name}`];
    const restarted =
      base !== undefined &&
      (cur.ins < base.ins ||
        cur.upd < base.upd ||
        cur.del < base.del ||
        s.indexes.some((i) => {
          const seen = seenOf(i.name);
          return (
            seen !== undefined && (i.scans < seen.scans || (seen.scanned && i.lastScanAt === null))
          );
        }));
    if (base === undefined || restarted) {
      state.types[key] = cur;
    } else {
      state.types[key] = base;
      if (now > base.at) {
        const writes = cur.ins - base.ins + (cur.upd - base.upd) + (cur.del - base.del);
        rates.set(key, (writes * 60_000) / (now - base.at));
      }
    }
    // A dropped index's entry goes, so one rebuilt under its name starts a new age.
    for (const i of s.indexes) {
      if (!i.engineOwned) continue;
      const seen = seenOf(i.name);
      state.indexes[`${key}\0${i.name}`] = {
        seen: seen === undefined || restarted ? now : seen.seen,
        scans: i.scans,
        scanned: i.lastScanAt !== null
      };
    }
  }
  // A type `typeStats` did not report is kept (unknown, not gone) while the
  // store still knows it; one no namespace declares any more is pruned.
  for (const [key, base] of Object.entries(prior?.types ?? {})) {
    if (stats.has(key)) continue;
    const [namespace, type] = JSON.parse(key) as [string, string];
    if ((await planOf(namespace, type)) === undefined) continue;
    state.types[key] = base;
    for (const [k, seen] of Object.entries(prior?.indexes ?? {})) {
      if (k.startsWith(`${key}\0`)) state.indexes[k] = seen;
    }
  }

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
      // when the advisor first saw it, or saw pg's statistics restart.
      const since = state.indexes[`${key}\0${i.name}`]?.seen ?? now;
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
  // Last write wins between two advisors on one store, which is safe: both
  // read the same pg counters, a baseline only moves forward or re-baselines,
  // and a lost first sighting is replaced by a later one. Either way rates
  // and ages stay conservative.
  await system.write(
    ADVISOR_STATE_TYPE,
    [{ id: ADVISOR_STATE_ID, stateJson: JSON.stringify(state) }],
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
        const served = planServesShape(plan, String(row.shape));
        if (served === undefined) continue;
        done = served;
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
    if (count < t.minReads || p95Ms < t.slowP95Ms) return undefined;
    // An OR or a NOT is not a conjunction a composite index serves.
    if (shape.disjunctive === true) return undefined;
    // An extension operator (semantic, …) is served by its own index, not a btree.
    if (shape.filters.some((f) => getExtensionOperator(f.op) !== undefined)) return undefined;
    const key = typeKey(shape.namespace, shape.type);
    const s = stats.get(key);
    if (s === undefined) return undefined;
    const plan = await planOf(shape.namespace, shape.type);
    if (plan === undefined) return undefined;
    const min = plan.expectedSize === 'large' ? t.minRowsLargeHint : t.minRows;
    if (s.liveRows < min) return undefined;
    const need = needOf(shape);
    if (plan.indexes.some((i) => serves(i, need))) return undefined;

    // An `indexes` entry keys on what `declarable` allows: the filter's
    // fields that qualify, then the order's up to its first that does not.
    const entry = deps.registry(shape.namespace)?.get(shape.type);
    const fields = entry?.kind === 'type' ? entry.fields : {};
    const declEq = need.eq.filter((f) => declarable(f, fields[f]));
    const stop = need.order.findIndex(([f]) => !declarable(f, fields[f]));
    const declOrder = stop === -1 ? need.order : need.order.slice(0, stop);
    if (declEq.length + declOrder.length === 0) return undefined;
    // A declaration an index already covers would add nothing.
    const declNeed: Need = { eq: declEq, literals: need.literals, order: declOrder };
    if (plan.indexes.some((i) => serves(i, declNeed))) return undefined;
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
