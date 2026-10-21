/**
 * Apply proposal helpers — runtime type + field registration.
 *
 * `applyTypeProposal` is the bridge between a stored TypeProposal (field specs
 * on the wire) and the live Registry: it parses each FieldSpecJson → FieldDef,
 * injects the engine-reserved shortId field (mirroring defineNamespace), and
 * delegates to `installAutoCrud` to register the full CRUD surface.
 *
 * `applyFieldProposal` extends an already-registered type with a new field by
 * replacing the type entry + all autoCRUD mutations with versions that include
 * the new field definition. The existing shortId field is preserved via spread.
 */

import {
  type AutoCrudRegistry,
  autoCrudOptionsOf,
  installAutoCrud,
  RESERVED_AUTOCRUD_FIELDS
} from '@mnmal-ai/substrate-sdk';
import type { Dataset, EdgesStore, FieldDef } from '@mnmal-ai/substrate-types';
import { ProposalError } from './errors.js';
import {
  assertCrossRefsOwned,
  assertProposableName,
  assertValidFieldSpec,
  type FieldSpecJson,
  parseFieldSpec
} from './field-spec-json.js';
import { PROPOSAL_TYPE_NAMES } from './namespace.js';
import type { RegistryStore } from './registry-store.js';

// Engine-reserved fields (currently { shortId: ... }) come from substrate-sdk, not a
// local copy, so a reserved field added there propagates here.

export interface ApplyTypeProposalArgs {
  namespace: string;
  typeName: string;
  fields: Record<string, FieldSpecJson>;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
}

/** Answers whether a crossRef may target `type` in `ns`. */
export type CrossRefTargetCheck = (ns: string, type: string) => boolean;

/**
 * Refuse a type proposal no caller could address, or whose crossRefs leave
 * the plugin's namespaces. The resolver passes a check that also requires the
 * target type to exist; replay cannot, as a target in another namespace may
 * not have been replayed yet.
 *
 * @throws ProposalError `invalid_params` / `invalid_field_spec`
 */
export function assertValidTypeProposal(
  typeName: unknown,
  fields: unknown,
  ownsTarget: CrossRefTargetCheck
): asserts fields is Record<string, FieldSpecJson> {
  assertProposableName('typeName', typeName);
  if (
    typeof fields !== 'object' ||
    fields === null ||
    Array.isArray(fields) ||
    Object.keys(fields).length === 0
  ) {
    throw new ProposalError('invalid_params', "'fields' must be a non-empty object", {
      param: 'fields'
    });
  }
  for (const [fieldName, spec] of Object.entries(fields as Record<string, FieldSpecJson>)) {
    assertValidFieldSpec(fieldName, spec);
    assertCrossRefsOwned(fieldName, spec, ownsTarget);
  }
}

/** As `assertValidTypeProposal`, for one field on `targetType`. */
export function assertValidFieldProposal(
  targetType: unknown,
  fieldName: string,
  fieldSpec: FieldSpecJson,
  ownsTarget: CrossRefTargetCheck
): void {
  assertProposableName('targetType', targetType);
  if ((PROPOSAL_TYPE_NAMES as readonly string[]).includes(targetType)) {
    throw new ProposalError(
      'invalid_params',
      `'${targetType}' is a proposal type and cannot take proposed fields`,
      { param: 'targetType' }
    );
  }
  assertValidFieldSpec(fieldName, fieldSpec);
  assertCrossRefsOwned(fieldName, fieldSpec, ownsTarget);
}

/** Installs the proposed type's autoCRUD surface into `registry`. */
function installProposedType(
  registry: AutoCrudRegistry,
  args: Pick<ApplyTypeProposalArgs, 'typeName' | 'fields' | 'dataset' | 'edges'>
): void {
  const fieldDefs: Record<string, FieldDef> = {};
  for (const [name, spec] of Object.entries(args.fields)) {
    fieldDefs[name] = parseFieldSpec(spec);
  }
  Object.assign(fieldDefs, RESERVED_AUTOCRUD_FIELDS);

  installAutoCrud(registry, args.typeName, args.dataset, args.edges, { fields: fieldDefs });
}

/**
 * Every registry key `applyTypeProposal` would register for this proposal —
 * the type name plus each autoCRUD operation name — without registering any.
 *
 * @returns the keys in registration order
 * @throws whatever `applyTypeProposal` would throw for an invalid field spec
 */
export function typeProposalRegistryKeys(
  args: Pick<ApplyTypeProposalArgs, 'typeName' | 'fields' | 'dataset' | 'edges'>
): string[] {
  const keys: string[] = [];
  installProposedType({ register: (key) => keys.push(key) }, args);
  return keys;
}

/**
 * Validates, then installs. Every path that turns a row into schema (the
 * resolver, boot replay, a peer's NOTIFY) passes through here, and a row can
 * be written directly by any holder of the propose capability.
 */
export function applyTypeProposal(args: ApplyTypeProposalArgs): void {
  const store = args.registryStore;
  assertValidTypeProposal(
    args.typeName,
    args.fields,
    (ns, type) => (ns === args.namespace && type === args.typeName) || store.ownsNamespace(ns)
  );
  const binding = store.getBinding(args.namespace);

  installProposedType(binding.registry, args);

  // Drop the engine's cached schema views so federatedSchema() and
  // schemaFor(ns) reflect the new type immediately. Unset before onStart,
  // when no engine (and so no cache) exists.
  binding.invalidateSchemaCaches?.();
}

export interface ApplyFieldProposalArgs {
  namespace: string;
  targetType: string;
  fieldName: string;
  fieldSpec: FieldSpecJson;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
}

/**
 * Extend an already-registered type with a new field.
 *
 * Replaces the type entry + all autoCRUD mutations atomically with versions
 * that include the new field. Uses a `replaceWriter` that funnels every
 * `register` call from installAutoCrud through `registry.replace()` so
 * DuplicateRegistration is never thrown.
 *
 * The replacement is strictly additive — existing rows without the new field
 * continue to read as field-absent.
 */
export function applyFieldProposal(args: ApplyFieldProposalArgs): void {
  const store = args.registryStore;
  assertValidFieldProposal(args.targetType, args.fieldName, args.fieldSpec, (ns) =>
    store.ownsNamespace(ns)
  );
  const binding = store.getBinding(args.namespace);
  const registry = binding.registry;
  const existing = registry.get(args.targetType);
  if (!existing) {
    throw new Error(`applyFieldProposal: target type '${args.targetType}' not registered`);
  }
  const nextFields: Record<string, FieldDef> = {
    ...existing.fields,
    [args.fieldName]: parseFieldSpec(args.fieldSpec)
  };
  // Funnel installAutoCrud's `register` calls through `replace` so the existing
  // type entry + mutations are swapped atomically without DuplicateRegistration.
  const replaceWriter = {
    register: (
      key: Parameters<typeof registry.replace>[0],
      input: Parameters<typeof registry.replace>[1]
    ) => registry.replace(key, input),
    replace: registry.replace.bind(registry)
  };
  // Keep what the type was installed with (policy, postWrite, purge); only the fields change.
  const prior = autoCrudOptionsOf(existing.resolver) ?? { policy: existing.policy };
  installAutoCrud(replaceWriter, args.targetType, args.dataset, args.edges, {
    ...prior,
    fields: nextFields
  });

  // Drop the engine's cached schema views so federatedSchema() and
  // schemaFor(ns) reflect the new field immediately.
  binding.invalidateSchemaCaches?.();
}
