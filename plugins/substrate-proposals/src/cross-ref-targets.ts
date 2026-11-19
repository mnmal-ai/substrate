/**
 * What a proposed crossRef may target, checked when a proposal is made, when
 * a proposal row is written directly, and when a stored proposal is applied.
 */

import { autoCrudOptionsOf } from '@mnmal-ai/substrate-sdk';
import {
  grantedIn,
  grantOf,
  type Id,
  type Identity,
  type Registry,
  type RequestContext,
  type ResolverArgs,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import { CONTROL_NAMESPACE } from './control-plane.js';
import {
  assertCrossRefTargets,
  type CrossRefTargetCheck,
  type FieldSpecJson,
  parseFieldSpec
} from './field-spec-json.js';
import type { RegistryStore } from './registry-store.js';
import { lockedInIdOrder, lockedRow } from './row-lock.js';

/**
 * The crossRef target check for a proposal in `namespace`. A target in a
 * namespace this plugin owns must pass `ownedTarget`; the control plane is
 * refused. Any other target must be in a namespace `canRead` admits, be a type
 * the engine has registered whose rows autoCRUD stores (a virtual type has no
 * rows to point at), and not be `restrict`, so a proposal never blocks deletes
 * of rows it does not own. The read rule runs first, so an unreadable
 * namespace never tells whether a type exists in it.
 */
export function crossRefTargetCheck(
  store: RegistryStore,
  namespace: string,
  ownedTarget: (ns: string, type: string) => boolean,
  canRead: (ns: string) => boolean
): CrossRefTargetCheck {
  return ({ ns, type, onDelete }) => {
    const target = `'${ns}/${type}'`;
    if (ns === CONTROL_NAMESPACE) return `${target} is in this plugin's control plane`;
    if (store.ownsNamespace(ns)) return ownedTarget(ns, type) ? null : `no type ${target}`;
    if (!canRead(ns)) return `you cannot read namespace '${ns}'`;
    const engine = store.has(namespace) ? store.getBinding(namespace).engine : undefined;
    const entry = engine?.typeEntry?.(ns, type);
    if (entry === undefined) return `no type ${target}`;
    if (autoCrudOptionsOf(entry.resolver) === undefined) return `${target} is not a stored type`;
    if (onDelete === 'restrict') {
      return `'restrict' is not allowed on a reference to ${target}, which this plugin does not own`;
    }
    return null;
  };
}

const always = (): boolean => true;

/**
 * The check for a stored proposal being applied. An owned target need not
 * exist yet, as replay may not have reached it. The read rule is left out, as
 * applying has no caller. A write through the engine that rewrites a row's
 * spec, or could leave the row live, was checked against its writer's read
 * (`gateProposalReferences`) on the row as the writes before it left it, a
 * concurrent one included. A row written straight to the store, past the
 * engine, was not checked.
 */
export function appliedTargetCheck(store: RegistryStore, namespace: string): CrossRefTargetCheck {
  return crossRefTargetCheck(store, namespace, always, always);
}

/** Whether boot applies a proposal row: the predicate replay reads stored rows by. */
export function isLiveProposal(row: Record<string, unknown>): boolean {
  return row.applied === true && row.supersededByCode === false && row.archived === false;
}

/**
 * Whether `identity` may read `ns`, as the engine's grant gate decides: no
 * grant is no claim, and passes.
 */
export function canReadNamespace(identity: Identity | null, ns: string): boolean {
  const grant = grantOf(identity);
  return grant === null || grantedIn(grant, ns).includes('read');
}

/** `json` parsed, or undefined when it is not a JSON string. */
function parsed(json: unknown): unknown {
  if (typeof json !== 'string') return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The field specs a TypeProposal write's `fieldsJson` names. */
function typeSpecs(params: Record<string, unknown>): Array<[string, unknown]> {
  const fields = parsed(params.fieldsJson);
  return typeof fields === 'object' && fields !== null && !Array.isArray(fields)
    ? Object.entries(fields)
    : [];
}

/** The field spec a FieldProposal write's `fieldSpecJson` names. */
function fieldSpecs(params: Record<string, unknown>): Array<[string, unknown]> {
  const spec = parsed(params.fieldSpecJson);
  if (spec === undefined) return [];
  const name = typeof params.fieldName === 'string' ? params.fieldName : 'fieldSpecJson';
  return [[name, spec]];
}

function parses(spec: unknown): spec is FieldSpecJson {
  try {
    parseFieldSpec(spec as FieldSpecJson);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update params that change neither a proposal row's specs nor whether boot
 * applies it: what `BENIGN_PROPOSAL_FIELDS` lists, plus the row's apply time
 * and its index, order, size and value-map options.
 */
const REFERENCE_NEUTRAL: ReadonlySet<string> = new Set([
  'id',
  'proposedReason',
  'proposedBy',
  'proposedAt',
  'resultingSchemaVersion',
  'appliedAt',
  'indexesJson',
  'orderedByJson',
  'expectedSize',
  'valueMapJson'
]);

/**
 * Update params that rewrite a proposal row's specs, or the type or field they
 * define: an update carrying one is checked whether or not the row is left live.
 */
const SPEC_KEYS: ReadonlySet<string> = new Set([
  'fieldsJson',
  'fieldSpecJson',
  'typeName',
  'targetType',
  'fieldName'
]);

/** The flags a row starts with when nothing is known of it: as live as it can be. */
const LIVE = { applied: true, supersededByCode: false, archived: false };

/**
 * Check the crossRefs of a TypeProposal or FieldProposal row written through
 * the engine as propose_type and propose_field do, against the writer's read,
 * with owned targets allowed before they exist. Boot applies every live row
 * with no caller to check, so a write meets the read rule here. Params whose
 * value is undefined are left out first, as the update resolver leaves them.
 *
 * A create is checked on its params, which are the whole row. An update that
 * rewrites a spec, or the type or field it defines, is checked on the row as
 * it will stand: the stored row with the update laid over it. So is an update
 * of other flags that leaves the row live, so whoever leaves a reference live
 * can read its target. An update of reference-neutral fields only, or one
 * that leaves the row not live and rewrites no spec, is not checked. The
 * stored row is read under a row lock held until the write's transaction
 * ends (a store whose transactions run one at a time needs none), so
 * concurrent updates of one row run their checks one after another, each on
 * the row as the one before left it, and the update then writes that row by
 * its stored id, whatever row its `id` names by then. An update that must be
 * checked but whose row cannot be loaded, or held still, is refused. A spec
 * that does not parse is left to apply, which refuses it. A mutate array runs
 * per element through the check; an array of updates first locks every row
 * it names, in id order.
 *
 * @throws ProposalError `invalid_field_spec` from the wrapped resolvers
 * @throws ResolverFrameError `policy_denied` when an update must be checked
 *   against a stored row that cannot be loaded or locked
 */
export function gateProposalReferences(
  registry: Registry,
  namespace: string,
  store: RegistryStore
): void {
  const guarded: Record<
    string,
    [type: string, specs: (row: Record<string, unknown>) => Array<[string, unknown]>]
  > = {
    createTypeProposal: ['TypeProposal', typeSpecs],
    updateTypeProposal: ['TypeProposal', typeSpecs],
    createFieldProposal: ['FieldProposal', fieldSpecs],
    updateFieldProposal: ['FieldProposal', fieldSpecs]
  };
  for (const [key, [type, specs]] of Object.entries(guarded)) {
    const entry = registry.get(key);
    if (entry === undefined) continue;
    const { batch: _batch, resolver, ...rest } = entry;
    const isUpdate = key.startsWith('update');
    const guard = async (ctx: RequestContext, args: ResolverArgs) => {
      const params = Object.fromEntries(
        Object.entries(args.params ?? {}).filter(([, v]) => v !== undefined)
      );
      const after = isUpdate ? await rowAfterUpdate(key, type, params, args.dataset) : undefined;
      const row = isUpdate ? after?.row : params;
      if (row !== undefined) {
        const check = crossRefTargetCheck(store, namespace, always, (ns) =>
          canReadNamespace(ctx.identity, ns)
        );
        for (const [name, spec] of specs(row)) {
          if (parses(spec)) assertCrossRefTargets(name, spec, check);
        }
      }
      return resolver(
        ctx,
        after === undefined ? args : { ...args, params: { ...args.params, id: after.id } }
      );
    };
    registry.replace(key, {
      ...rest,
      resolver: guard,
      ...(isUpdate ? { batch: lockedInIdOrder(type, guard) } : {})
    });
  }
}

/**
 * The stored row an update of `type` reaches, locked, with the row the update
 * will leave when that needs checking. Undefined when no check needs the
 * stored row: every param is reference-neutral, or the update rewrites no
 * spec and the row will not be live.
 *
 * @throws ResolverFrameError `policy_denied` when the row cannot be loaded or locked
 */
async function rowAfterUpdate(
  key: string,
  type: string,
  params: Record<string, unknown>,
  dataset: ResolverArgs['dataset']
): Promise<{ id: Id; row: Record<string, unknown> | undefined } | undefined> {
  const keys = Object.keys(params);
  if (keys.every((k) => REFERENCE_NEUTRAL.has(k))) return undefined;
  const rewritesSpec = keys.some((k) => SPEC_KEYS.has(k));
  if (!rewritesSpec && !isLiveProposal({ ...LIVE, ...params })) return undefined;
  const stored = await lockedRow(type, params.id, dataset);
  if (stored === null) {
    throw new ResolverFrameError(
      'policy_denied',
      `${key}: cannot load the row to check the references this update leaves`
    );
  }
  const row = { ...stored, ...params };
  return { id: stored.id, row: rewritesSpec || isLiveProposal(row) ? row : undefined };
}
