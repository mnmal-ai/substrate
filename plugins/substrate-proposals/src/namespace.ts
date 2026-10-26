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
import {
  DEFAULT_INDEX_CAPABILITY,
  DEFAULT_PROPOSE_CAPABILITY,
  proposeToWrite
} from './capability.js';

export function defineProposalTypes(
  namespace: string,
  capability: string = DEFAULT_PROPOSE_CAPABILITY,
  indexCapability: string = DEFAULT_INDEX_CAPABILITY
): NamespaceDefinition {
  const policy = proposeToWrite(capability, indexCapability);
  return defineNamespace(namespace, {
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
        orderedByJson: field.string({ indexed: false, nullable: true })
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
}

/** The canonical ordered list of type names registered by this namespace. */
export const PROPOSAL_TYPE_NAMES = ['TypeProposal', 'FieldProposal'] as const;
