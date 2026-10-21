/**
 * Control-plane namespace for substrate-proposals.
 *
 * `_system_proposals` is reserved by the plugin and houses the NamespaceProposal
 * autoCRUD type. It's installed alongside any user-facing ownedNamespaces and
 * cannot be passed in `ownedNamespaces` (the plugin throws on collision at
 * construction). The leading underscore follows the `_system*` system-reserved
 * namespace convention (mirrors `_system` admin namespace).
 *
 * The NamespaceProposal type tracks runtime namespace additions for restart
 * recovery: applied=true rows are replayed by reconcileClusterNamespaces on
 * cold boot, before the per-namespace TypeProposal/FieldProposal reconcile.
 *
 * `supersededByCode` mirrors TypeProposal/FieldProposal — set when a namespace
 * proposed at runtime is later added to static plugin config (`ownedNamespaces`). The proposal row stays for
 * audit/queryability; the static-config path becomes the source of truth.
 */

import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { DEFAULT_PROPOSE_CAPABILITY, proposeToWrite } from './capability.js';

export const CONTROL_NAMESPACE = '_system_proposals';

/** The pattern `defineNamespace` enforces: no '/' (frame keys) and no ':' (grant syntax). */
const NAMESPACE_NAME = /^[A-Za-z0-9_-]+$/;

/** A name `propose_namespace` may create, and so the only kind replay may install. */
export function isProposableNamespace(ns: unknown): ns is string {
  return typeof ns === 'string' && NAMESPACE_NAME.test(ns) && ns !== CONTROL_NAMESPACE;
}

export function defineControlPlaneTypes(
  capability: string = DEFAULT_PROPOSE_CAPABILITY
): NamespaceDefinition {
  return defineNamespace(CONTROL_NAMESPACE, {
    NamespaceProposal: {
      // Boot replays applied rows into live namespaces, as for TypeProposal.
      policy: proposeToWrite(capability),
      fields: {
        ns: field.string(),
        proposedBy: field.string(),
        proposedAt: field.date(),
        proposedReason: field.string({ indexed: false }),
        applied: field.boolean(),
        appliedAt: field.date({ nullable: true }),
        supersededByCode: field.boolean(),
        archived: field.boolean()
      }
    }
  });
}

export const CONTROL_TYPE_NAMES = ['NamespaceProposal'] as const;
