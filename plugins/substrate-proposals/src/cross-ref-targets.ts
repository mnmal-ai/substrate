/**
 * What a proposed crossRef may target, checked when a proposal is made, when
 * a proposal row is written directly, and when a stored proposal is applied.
 */

import {
  grantedIn,
  grantOf,
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

/**
 * The crossRef target check for a proposal in `namespace`. A target in a
 * namespace this plugin owns must pass `ownedTarget`; the control plane is
 * refused. Any other target must be in a namespace `canRead` admits, be a type
 * the engine has registered with storage behind it, and not be `restrict`, so
 * a proposal never blocks deletes of rows it does not own. The read rule runs
 * first, so an unreadable namespace never tells whether a type exists in it.
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
    if (engine?.hasType?.(ns, type) !== true) return `no type ${target}`;
    if (engine.datasetFor(ns) === undefined) return `${target} is not a stored type`;
    if (onDelete === 'restrict') {
      return `'restrict' is not allowed on a reference to ${target}, which this plugin does not own`;
    }
    return null;
  };
}

const always = (): boolean => true;

/**
 * The check for a stored proposal being applied. An owned target need not
 * exist yet, as replay may not have reached it. The read rule is left out:
 * applying has no caller, and every write of a proposal row through the
 * engine was checked against its writer's read (`gateProposalReferences`).
 */
export function appliedTargetCheck(store: RegistryStore, namespace: string): CrossRefTargetCheck {
  return crossRefTargetCheck(store, namespace, always, always);
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
 * Whether an update's `params` can change what boot makes live from its row:
 * the spec, the name it is applied under, or the row becoming applied or
 * unarchived.
 */
function changesLive(params: Record<string, unknown>): boolean {
  return (
    ['fieldsJson', 'fieldSpecJson', 'typeName', 'targetType'].some((k) =>
      Object.hasOwn(params, k)
    ) ||
    params.applied === true ||
    params.archived === false
  );
}

/**
 * Check the crossRefs of a TypeProposal or FieldProposal row written through
 * the engine as propose_type and propose_field do, against the writer's read,
 * with owned targets allowed before they exist. Boot applies every applied
 * row with no caller to check, so a direct write meets the read rule here. An
 * update that can change what boot makes live is checked on the row as it
 * will stand, the stored row with the update laid over it, so whoever makes a
 * reference live must be able to read its target. A spec that does not parse
 * is left to apply, which refuses it. The guarded entries lose `batch`, so a
 * mutate array runs per element through the check.
 *
 * @throws ProposalError `invalid_field_spec` from the wrapped resolvers
 * @throws ResolverFrameError `policy_denied` when an update must be checked
 *   against its stored row and there is no dataset to read it from
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
    registry.replace(key, {
      ...rest,
      resolver: async (ctx: RequestContext, args: ResolverArgs) => {
        const params = args.params ?? {};
        let row: Record<string, unknown> | undefined = params;
        if (isUpdate) {
          row = changesLive(params) ? params : undefined;
          // Without an id the update reaches no row; the update itself refuses it.
          if (row !== undefined && typeof params.id === 'string') {
            if (args.dataset === undefined) {
              throw new ResolverFrameError(
                'policy_denied',
                `${key}: cannot check the stored row's references without a dataset`
              );
            }
            const { rows } = await args.dataset.read(type, { id: params.id, limit: 1 });
            row = { ...rows[0], ...params };
          }
        }
        if (row !== undefined) {
          const check = crossRefTargetCheck(store, namespace, always, (ns) =>
            canReadNamespace(ctx.identity, ns)
          );
          for (const [name, spec] of specs(row)) {
            if (parses(spec)) assertCrossRefTargets(name, spec, check);
          }
        }
        return resolver(ctx, args);
      }
    });
  }
}
