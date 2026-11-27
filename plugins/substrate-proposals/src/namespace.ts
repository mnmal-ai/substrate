/**
 * substrate-proposals namespace definition.
 *
 * Defines two types for schema evolution proposals:
 *   - TypeProposal: proposes a new type (multiple fields at once), and holds
 *     the indexes and natural order `propose_index` gives it
 *   - FieldProposal: proposes a single field on an existing type
 *
 * Both track proposal metadata (proposedBy, proposedAt, reason) and application
 * state (applied, appliedAt). The `supersededByCode` flag indicates that a
 * proposal was made obsolete by unrelated code changes — distinct from an
 * explicit `superseded` status in decision-tracking.
 *
 * First-past-the-post uniqueness is enforced by a read-before-write check in
 * the propose resolvers, held under a per-name lock (`proposal-lock.ts`), not
 * by a schema or database constraint.
 */

import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { registryActions } from './action-layer.js';
import {
  DEFAULT_DROP_CAPABILITY,
  DEFAULT_INDEX_CAPABILITY,
  DEFAULT_PROPOSE_CAPABILITY,
  gateFieldProposalRemoval,
  gateTypeProposalRemoval,
  proposeToWrite,
  stampProposedBy
} from './capability.js';
import { gateProposalReferences } from './cross-ref-targets.js';
import type { RegistryStore } from './registry-store.js';

export function defineProposalTypes(
  namespace: string,
  registryStore: RegistryStore,
  capability: string = DEFAULT_PROPOSE_CAPABILITY,
  indexCapability: string = DEFAULT_INDEX_CAPABILITY,
  dropCapability: string = capability === '' ? '' : DEFAULT_DROP_CAPABILITY
): NamespaceDefinition {
  const policy = proposeToWrite(capability, indexCapability);
  const def = defineNamespace(namespace, {
    TypeProposal: {
      policy,
      fields: {
        typeName: field.string(),
        fieldsJson: field.string({ indexed: false }),
        proposedBy: field.string(),
        proposedAt: field.date(),
        proposedReason: field.string({ indexed: false }),
        applied: field.boolean(),
        appliedAt: field.date({ nullable: true }),
        resultingSchemaVersion: field.string({ nullable: true }),
        supersededByCode: field.boolean(),
        archived: field.boolean(),
        /** `IndexDecl[]` as JSON, set by `propose_index add`; null for none. */
        indexesJson: field.string({ indexed: false, nullable: true }),
        /** `OrderedBy` as JSON, set by `propose_index orderedBy`; null for the default. */
        orderedByJson: field.string({ indexed: false, nullable: true }),
        /** `'small' | 'large'`, the proposer's size hint for the index advisor; null when none. */
        expectedSize: field.enum(['small', 'large'], { indexed: false, nullable: true }),
        /** The actions born with the type, `Record<string, ActionDecl>` as JSON; null for none. */
        actionsJson: field.string({ indexed: false, nullable: true })
      }
    },
    FieldProposal: {
      policy,
      fields: {
        targetType: field.string(),
        fieldName: field.string(),
        fieldSpecJson: field.string({ indexed: false }),
        proposedBy: field.string(),
        proposedAt: field.date(),
        proposedReason: field.string({ indexed: false }),
        valueMapJson: field.string({ indexed: false, nullable: true }),
        applied: field.boolean(),
        appliedAt: field.date({ nullable: true }),
        resultingSchemaVersion: field.string({ nullable: true }),
        supersededByCode: field.boolean(),
        archived: field.boolean()
      }
    }
  });
  return {
    ...def,
    install(ctx) {
      def.install(ctx);
      gateTypeProposalRemoval(ctx.registry, dropCapability, (typeName) =>
        chainsInto(registryStore, namespace, typeName)
      );
      gateFieldProposalRemoval(ctx.registry, dropCapability);
      gateProposalReferences(ctx.registry, namespace, registryStore);
      stampProposedBy(ctx.registry, PROPOSAL_TYPE_NAMES);
    }
  };
}

/**
 * The registry actions, keyed `ns/Type.name`, on types other than
 * `namespace/typeName` whose `then` targets one of its actions.
 */
// shortcut: chains are read from this engine's registry, which keeps a type whose proposal was
// archived until restart. So a chaining type archived that way still blocks removal until then, and
// propose_type can chain a new type to such a type, which replay then skips at the next boot. Read
// the live TypeProposal rows, here and in propose_type's check, if either bites.
function chainsInto(registryStore: RegistryStore, namespace: string, typeName: string): string[] {
  const engine = registryStore.has(namespace)
    ? registryStore.getBinding(namespace).engine
    : undefined;
  const prefix = `${namespace}/${typeName}.`;
  return [...registryActions(engine?.federatedSchema() ?? {})]
    .filter(
      ([key, a]) => !key.startsWith(prefix) && a.then.some((t) => t.action.startsWith(prefix))
    )
    .map(([key]) => key);
}

/** The canonical ordered list of type names registered by this namespace. */
export const PROPOSAL_TYPE_NAMES = ['TypeProposal', 'FieldProposal'] as const;
