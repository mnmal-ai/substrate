/**
 * What the engine knows about the walks in a query frame: how each hop
 * resolves, where its walk sites are, and which of its clauses the store's
 * indexes serve.
 */

import { type TypeRef, usesWalkGrammar } from '@mnmal-ai/substrate-filter';
import type {
  Dataset,
  DatasetRegistry,
  FieldDef,
  FrameEntry,
  IndexPlan,
  MetadataHop,
  OrderedBy,
  PlanClause,
  Schema,
  TypeSchema
} from '@mnmal-ai/substrate-types';
import { naturalOrderOf } from '@mnmal-ai/substrate-types';
import { classifyWalkService, type WalkSite, walkSites } from '../advisor/walk-service.js';
import type { WalkResolvers } from '../filter/walk-validator.js';
import { type HopResolver, hopResolver } from '../walk-types.js';
import type { MetricFn } from './internals.js';

/** A walk-grammar frame's walks, resolved once for the shape recorder and the plan. */
export interface WalkScan {
  sites: WalkSite[];
  resolve: HopResolver;
  fieldsOf: (ref: TypeRef) => Record<string, FieldDef> | undefined;
  naturalOrder: (ref: TypeRef) => OrderedBy;
}

export interface EngineWalksDeps {
  datasets: DatasetRegistry;
  metric: MetricFn;
  schemaFor: (ns: string) => Schema;
}

export class EngineWalks {
  readonly #datasets: DatasetRegistry;
  readonly #metric: MetricFn;
  readonly #schemaFor: (ns: string) => Schema;

  constructor(deps: EngineWalksDeps) {
    this.#datasets = deps.datasets;
    this.#metric = deps.metric;
    this.#schemaFor = deps.schemaFor;
  }

  /**
   * Far-type resolution for the metadata rewrite, each far type in its own
   * namespace; a hop that does not resolve, or that `walk` refuses, is left to
   * the validator.
   */
  metadataHop(ns: string, from: string, walk: WalkResolvers | undefined): MetadataHop {
    const tools = this.walkTools(ns, walk);
    const hopFrom =
      (type: TypeRef): MetadataHop =>
      (node) => {
        let far: TypeRef;
        try {
          far = tools.resolve(node, type, []);
        } catch {
          return undefined;
        }
        const fields = tools.schemaOf(far)?.fields;
        return fields !== undefined ? { fields, hop: hopFrom(far) } : undefined;
      };
    return hopFrom({ ns, type: from });
  }

  /**
   * Hop resolution, field declarations and natural order for walks seeded in
   * `ns`, each far type read in its own namespace. Hops leave `ns` only as
   * `walk` allows.
   */
  walkTools(
    ns: string,
    walk?: WalkResolvers
  ): Omit<WalkScan, 'sites'> & { schemaOf: (ref: TypeRef) => TypeSchema | undefined } {
    const types = this.#schemaFor(ns).types;
    const schemaOf = (ref: TypeRef) => {
      const own = ref.ns === ns ? types : walk?.schemaOf?.(ref.ns);
      return own !== undefined && Object.hasOwn(own, ref.type) ? own[ref.type] : undefined;
    };
    return {
      resolve: hopResolver(ns, types, walk),
      schemaOf,
      fieldsOf: (ref) => schemaOf(ref)?.fields,
      naturalOrder: (ref) => naturalOrderOf(schemaOf(ref) ?? {})
    };
  }

  /**
   * The walk sites of a walk-grammar query frame, or undefined for an ordinary
   * one, each far type in its own namespace. Asked only of a frame the walk
   * gate passed, with the `walk` resolvers it passed under.
   */
  walkSitesOf(
    frame: FrameEntry,
    ns: string,
    seed: string,
    walk: WalkResolvers | undefined
  ): WalkScan | undefined {
    if (!usesWalkGrammar(frame as Record<string, unknown>)) return undefined;
    const tools = this.walkTools(ns, walk);
    try {
      const sites = walkSites(
        frame as Record<string, unknown>,
        { ns, type: seed },
        tools.resolve,
        tools.naturalOrder
      );
      return { sites, ...tools };
    } catch {
      // A describer never fails the read.
      return undefined;
    }
  }

  /**
   * The frame's clauses marked index-served (goal 7), from the store's index
   * plans, each type's asked of its own namespace's dataset. Undefined when
   * the store has none (memory) or any type's plan is unknown: a plan that
   * cannot be judged is omitted, never guessed.
   */
  async walkPlan(
    dataset: Dataset,
    key: string,
    frame: FrameEntry,
    ns: string,
    seed: string,
    scan: WalkScan
  ): Promise<PlanClause[] | undefined> {
    if (dataset.indexPlan === undefined) return undefined;
    const qualified = (r: TypeRef) => `${r.ns}/${r.type}`;
    const types = new Map(
      [{ ns, type: seed }, ...scan.sites.map((s) => s.far)].map((r) => [qualified(r), r])
    );
    let plans: Array<IndexPlan | undefined>;
    try {
      plans = await Promise.all(
        [...types.values()].map((r) =>
          (r.ns === ns ? dataset : this.#datasets.get(r.ns))?.indexPlan?.(r.type, r.ns)
        )
      );
    } catch (err) {
      this.#metric('engine_walk_plan_failed', {
        key,
        error: err instanceof Error ? err.message : String(err)
      });
      return undefined;
    }
    if (plans.some((p) => p === undefined)) return undefined;
    const byType = new Map([...types.keys()].map((t, i) => [t, plans[i]?.indexes ?? []]));
    return classifyWalkService(
      {
        entry: frame as Record<string, unknown>,
        seed: { ns, type: seed },
        resolve: scan.resolve,
        fieldsOf: scan.fieldsOf,
        naturalOrder: scan.naturalOrder
      },
      (r) => byType.get(qualified(r)) ?? []
    );
  }
}
