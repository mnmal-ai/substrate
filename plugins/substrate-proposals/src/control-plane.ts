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
 * namespace they target; only the plugin writes it, apart from an admin's
 * archive (a veto or a retire).
 *
 * `supersededByCode` mirrors TypeProposal/FieldProposal — set when a namespace
 * proposed at runtime is later added to static plugin config (`ownedNamespaces`). The proposal row stays for
 * audit/queryability; the static-config path becomes the source of truth.
 */

import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import {
  type NamespaceDefinition,
  type Registry,
  type RegistryEntryResolver,
  ResolverFrameError,
  type Row
} from '@mnmal-ai/substrate-types';
import {
  DEFAULT_DROP_CAPABILITY,
  DEFAULT_PROPOSE_CAPABILITY,
  gateNamespaceProposalLiveness,
  makeProposePolicy,
  proposeToWrite,
  stampProposedBy,
  TRUSTED_WRITE
} from './capability.js';
import { notifyAfterCommit } from './engine-write.js';
import type { RegistryStore } from './registry-store.js';
import { lockedInIdOrder, lockedRow } from './row-lock.js';

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
  dropCapability: string = capability === '' ? '' : DEFAULT_DROP_CAPABILITY,
  /** Runs once an ActionProposal archive commits, with the row as written. */
  actionArchived: (row: Row) => Promise<void> = async () => {}
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
      gateActionProposalWrites(ctx.registry, dropCapability, actionArchived);
      stampProposedBy(ctx.registry, CONTROL_TYPE_NAMES);
    }
  };
}

/** Whether an update's params only archive its row: `{ id, archived: true }`. */
function onlyArchives(params: Record<string, unknown>): boolean {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined);
  return params.archived === true && keys.every((k) => k === 'id' || k === 'archived');
}

/**
 * ActionProposal rows change only through the plugin's own writes
 * ({@link TRUSTED_WRITE}), because the action layer is built from them, and
 * through an archive by a holder of the drop capability in the row's
 * `targetNamespace`: archiving a pending word vetoes it, a promoted one
 * retires it. The row is locked from the check to the commit, and once
 * committed goes to `archived`. Every other client create, update or delete
 * is refused. A mutate array runs per element through the guard, an array of
 * updates first locking its rows in id order; `updateMany` / `deleteMany`
 * refuse once their single-row entry is replaced.
 */
function gateActionProposalWrites(
  registry: Registry,
  dropCapability: string,
  archived: (row: Row) => Promise<void>
): void {
  const gate = makeProposePolicy(dropCapability);
  for (const key of ['createActionProposal', 'updateActionProposal', 'deleteActionProposal']) {
    const entry = registry.get(key);
    if (entry === undefined) continue;
    const { batch: _batch, resolver, ...rest } = entry;
    const guard: RegistryEntryResolver = async (ctx, args) => {
      if ((args as { [TRUSTED_WRITE]?: true })[TRUSTED_WRITE] === true) return resolver(ctx, args);
      const params = args.params ?? {};
      if (key !== 'updateActionProposal' || !onlyArchives(params)) {
        throw new ResolverFrameError(
          'policy_denied',
          `${key}: ActionProposal records change only through propose_action, or an archive by '${dropCapability}' in their namespace`
        );
      }
      const row = await lockedRow('ActionProposal', params.id, args.dataset);
      const ns = row?.targetNamespace;
      if (row === null || typeof ns !== 'string') {
        throw new ResolverFrameError(
          'policy_denied',
          `${key}: cannot load the record to check its namespace; needs '${dropCapability}' there`
        );
      }
      if (!gate({ ...ctx, namespace: ns }, args).allow) {
        throw new ResolverFrameError(
          'policy_denied',
          `${key}: archiving a word in '${ns}' vetoes or retires it, which needs '${dropCapability}' there`,
          { required: `${ns}:${dropCapability}` }
        );
      }
      const status =
        row.status === 'pending' ? 'vetoed' : row.status === 'promoted' ? 'retired' : row.status;
      const out = await resolver(ctx, {
        ...args,
        params: { id: row.id, archived: true, status }
      });
      await notifyAfterCommit(args, () => archived({ ...row, archived: true, status }));
      return out;
    };
    registry.replace(key, {
      ...rest,
      resolver: guard,
      ...(key === 'updateActionProposal' ? { batch: lockedInIdOrder('ActionProposal', guard) } : {})
    });
  }
}

export const CONTROL_TYPE_NAMES = ['NamespaceProposal', 'ActionProposal'] as const;
