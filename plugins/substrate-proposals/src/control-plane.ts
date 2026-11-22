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
 * ActionProposal holds the action words agents coin with `define`, whatever
 * namespace they target; only the plugin writes it.
 *
 * `supersededByCode` mirrors TypeProposal/FieldProposal — set when a namespace
 * proposed at runtime is later added to static plugin config (`ownedNamespaces`). The proposal row stays for
 * audit/queryability; the static-config path becomes the source of truth.
 */

import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import {
  type NamespaceDefinition,
  type Registry,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import {
  DEFAULT_DROP_CAPABILITY,
  DEFAULT_PROPOSE_CAPABILITY,
  gateNamespaceProposalLiveness,
  proposeToWrite,
  stampProposedBy,
  TRUSTED_WRITE
} from './capability.js';
import type { RegistryStore } from './registry-store.js';

export const CONTROL_NAMESPACE = '_system_proposals';

/** The pattern `defineNamespace` enforces: no '/' (frame keys) and no ':' (grant syntax). */
const NAMESPACE_NAME = /^[A-Za-z0-9_-]+$/;

/** A name `propose_namespace` may create, and so the only kind replay may install. */
export function isProposableNamespace(ns: unknown): ns is string {
  return typeof ns === 'string' && NAMESPACE_NAME.test(ns) && ns !== CONTROL_NAMESPACE;
}

export function defineControlPlaneTypes(
  registryStore: RegistryStore,
  capability: string = DEFAULT_PROPOSE_CAPABILITY,
  // shortcut: not threaded from SUBSTRATE_ADMIN_CAPABILITY, as for defineProposalTypes.
  dropCapability: string = capability === '' ? '' : DEFAULT_DROP_CAPABILITY
): NamespaceDefinition {
  const def = defineNamespace(CONTROL_NAMESPACE, {
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
    },
    // A coined action word (`propose_action`); the action layer is built from these rows.
    ActionProposal: {
      fields: {
        targetNamespace: field.string(),
        targetType: field.string(),
        name: field.string(),
        declJson: field.string({ indexed: false }),
        sketch: field.string({ indexed: false }),
        proposedBy: field.string(),
        proposedAt: field.date(),
        status: field.enum(['pending', 'promoted', 'vetoed', 'retired', 'superseded']),
        uses: field.number(),
        lastUseAt: field.date({ nullable: true }),
        promotedAt: field.date({ nullable: true }),
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
      gateNamespaceProposalLiveness(ctx.registry, registryStore, dropCapability);
      gateActionProposalWrites(ctx.registry);
      stampProposedBy(ctx.registry, CONTROL_TYPE_NAMES);
    }
  };
}

/**
 * ActionProposal rows change only through the plugin's own writes
 * ({@link TRUSTED_WRITE}), because the action layer is built from them: every
 * client create, update or delete is refused, a mutate array per element.
 * `updateMany` / `deleteMany` refuse once their single-row entry is replaced.
 */
function gateActionProposalWrites(registry: Registry): void {
  for (const key of ['createActionProposal', 'updateActionProposal', 'deleteActionProposal']) {
    const entry = registry.get(key);
    if (entry === undefined) continue;
    const { batch: _batch, resolver, ...rest } = entry;
    registry.replace(key, {
      ...rest,
      resolver: (ctx, args) => {
        if ((args as { [TRUSTED_WRITE]?: true })[TRUSTED_WRITE] !== true) {
          throw new ResolverFrameError(
            'policy_denied',
            `${key}: ActionProposal records change only through propose_action`
          );
        }
        return resolver(ctx, args);
      }
    });
  }
}

export const CONTROL_TYPE_NAMES = ['NamespaceProposal', 'ActionProposal'] as const;
