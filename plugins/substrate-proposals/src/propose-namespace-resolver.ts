/**
 * propose_namespace — runtime namespace creation.
 *
 * Hot-adds a new namespace to the live engine without a binary restart, e.g.
 * to provision per-user / per-tenant namespaces on demand. Mirrors
 * `propose_type` in shape and first-past-the-post (FPP) collision semantics.
 * Steps 2-9 run under the proposal lock for the ns, so of two racing callers
 * the second reads the first's committed row and throws
 * `namespace_already_proposed` with prior context.
 *
 * Steps:
 *   1. Refuse the control-plane ns + malformed names (`invalid_namespace`).
 *   2. FPP check on the non-archived NamespaceProposal for this ns. A row from
 *      another proposer, or an applied one, → `namespace_already_proposed`. An
 *      applied=false row from the same signed caller is a stranded earlier attempt
 *      and is resumed: steps 5-9 run against it. With no row, an ns installed
 *      on this engine other than by an earlier propose_namespace →
 *      `invalid_namespace`.
 *   3. Verify dataset for the new ns is provisioned. The host MUST have
 *      registered it before calling; missing → `dataset_not_provisioned`.
 *      Runs BEFORE the row write so a misconfigured `datasetFor` does not
 *      strand an applied=false row.
 *   4. Persist the NamespaceProposal row in the control-plane ns
 *      (`applied=false`) through autoCRUD on the caller's transaction, so
 *      `_metadata`, `shortId` and the `postWrite` hook apply. Skipped when
 *      resuming.
 *   5. `engine.addNamespace(ns, { registry: engine.createRegistry() })`,
 *      skipped when a stranded attempt already added it.
 *   6. Install TypeProposal + FieldProposal autoCRUD and the propose_*
 *      mutations onto the new ns, skipping entries already registered, and
 *      stash the binding in the RegistryStore.
 *   7. Mark the proposal row `applied=true` (autoCRUD-routed update).
 *   8. NOTIFY on the cluster channel `_substrate_proposals_cluster` with the ns
 *      name once the caller's transaction commits, so peers can't observe a
 *      half-applied state.
 *   9. Return the applied row.
 *
 * The row writes commit with the caller's transaction, so a failure in steps
 * 5-7 rolls the row back and leaves only the install; the same proposer's retry
 * completes it. Reconcile replays only applied=true rows, so until then the ns
 * is not restored on restart.
 */

import { randomUUID } from 'node:crypto';
import { resolveIdentity } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  EdgesStore,
  EngineHandle,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import type { PubSub } from './config.js';
import { isProposableNamespace } from './control-plane.js';
import { notifyAfterCommit, writeInTx } from './engine-write.js';
import { ProposalError } from './errors.js';
import { type InstallHotAddedNamespaceArgs, installHotAddedNamespace } from './multi-instance.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import type { RegistryStore } from './registry-store.js';

export const CLUSTER_CHANNEL = '_substrate_proposals_cluster';

export interface ProposeNamespaceInput {
  ns: string;
  proposedReason: string;
}

export interface ProposeNamespaceResolverDeps {
  controlNamespace: string;
  registryStore: RegistryStore;
  datasetFor: (ns: string) => Dataset | undefined;
  edges: EdgesStore;
  pubsub: PubSub;
  proposeCapability?: string;
  /** Capability that writes to a proposal row's indexes need; see `proposeToWrite`. */
  indexCapability?: string;
  /** See InstallHotAddedNamespaceArgs.registerProposalMutations. */
  registerProposalMutations?: InstallHotAddedNamespaceArgs['registerProposalMutations'];
}

export function makeProposeNamespaceResolver(
  deps: ProposeNamespaceResolverDeps
): (ctx: RequestContext, args: ResolverArgs) => Promise<Row> {
  return async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    const input = (args.params ?? {}) as unknown as ProposeNamespaceInput;
    const { ns } = input;

    // Step 1 — refuse the control-plane ns + malformed inputs
    if (!isProposableNamespace(ns) || ns === deps.controlNamespace) {
      throw new ProposalError(
        'invalid_namespace',
        `${JSON.stringify(ns)} cannot be proposed (reserved, or not matching [A-Za-z0-9_-]+)`
      );
    }
    if (input.proposedReason !== undefined && typeof input.proposedReason !== 'string') {
      throw new ProposalError('invalid_params', "'proposedReason' must be a string", {
        param: 'proposedReason'
      });
    }

    // The caller's transaction, so the lock, reads and writes share its one
    // connection.
    const dataset = args.dataset ?? deps.registryStore.getBinding(deps.controlNamespace).dataset;
    return withProposalLock(dataset, proposalLockKey('namespace', deps.controlNamespace, ns), () =>
      proposeNamespaceLocked(deps, ctx, { ...args, dataset }, input)
    );
  };
}

/** Steps 2-9, run while holding the proposal lock for this namespace. */
async function proposeNamespaceLocked(
  deps: ProposeNamespaceResolverDeps,
  ctx: RequestContext,
  args: ResolverArgs & { dataset: Dataset },
  input: ProposeNamespaceInput
): Promise<Row> {
  const { ns } = input;
  const proposedReason = input.proposedReason ?? '';
  // The signed caller, never a param: it decides who may resume a stranded row.
  const proposedBy = resolveIdentity(ctx).id;
  const controlBinding = deps.registryStore.getBinding(deps.controlNamespace);
  const controlEngine = controlBinding.engine;

  // Step 2 — FPP check on prior non-archived NamespaceProposal rows. An
  // applied=false row from the same signed caller is a stranded earlier attempt
  // (the lock rules out one still in flight), so it is resumed, not refused.
  const existing = await args.dataset.read('NamespaceProposal', {
    where: { AND: [{ ns: { eq: ns } }, { archived: { eq: false } }] },
    limit: 1
  });
  // A dropped namespace's name stays reserved: grants and invites name
  // namespaces by string, so a new namespace under an old name would hand the
  // old grantees its rows. Only a drop archives a NamespaceProposal row.
  const retired = await args.dataset.read('NamespaceProposal', {
    where: { AND: [{ ns: { eq: ns } }, { archived: { eq: true } }] },
    limit: 1
  });
  if (retired.rows.length > 0) {
    throw new ProposalError(
      'namespace_retired',
      `'${ns}' was dropped and its name is reserved; existing grants may still name it`
    );
  }
  const prior = existing.rows[0] as
    | (Row & { proposedBy: string; proposedAt: Date | string; applied: boolean })
    | undefined;
  const resuming =
    prior !== undefined && prior.applied === false && prior.proposedBy === proposedBy;
  if (prior !== undefined && !resuming) {
    throw new ProposalError(
      'namespace_already_proposed',
      `Namespace '${ns}' already proposed (by ${String(prior.proposedBy)})`,
      { by: prior.proposedBy, at: prior.proposedAt }
    );
  }
  // A hot-added binding with no row is an attempt whose row write was rolled
  // back after the install landed; it is completed like a stranded row. Any
  // other name the engine holds (another plugin's) is refused, and a
  // tombstoned (dropped) one always is, so a proposal can neither install
  // into it nor have its rollback clear the tombstone.
  const state = controlEngine?.namespaceState(ns) ?? 'absent';
  const held = deps.registryStore.has(ns)
    ? deps.registryStore.getBinding(ns).hotAdded !== true
    : state !== 'absent';
  if (state === 'tombstoned' || (!resuming && held)) {
    throw new ProposalError(
      'invalid_namespace',
      `'${ns}' is already installed on this engine and cannot be proposed`
    );
  }

  // Step 3 — dataset must already be provisioned for the new ns. Runs
  // BEFORE the row write so a misconfigured `datasetFor` does NOT strand
  // an applied=false row.
  const newDataset = deps.datasetFor(ns);
  if (newDataset === undefined) {
    throw new ProposalError(
      'dataset_not_provisioned',
      `No dataset registered for '${ns}'. Host must register the dataset before propose_namespace.`
    );
  }

  if (controlEngine === undefined) {
    throw new ProposalError(
      'engine_not_wired',
      'propose_namespace requires the control-plane engine handle (wired by onStart)'
    );
  }

  // Step 4 — write the row (applied=false initially) through autoCRUD, or
  // reuse the stranded row when resuming.
  let proposalId: string;
  if (prior !== undefined) {
    proposalId = String(prior.id);
  } else {
    proposalId = randomUUID();
    await writeInTx(controlBinding.registry, ctx, args, 'createNamespaceProposal', {
      id: proposalId,
      ns,
      proposedBy,
      proposedAt: new Date(),
      proposedReason,
      applied: false,
      appliedAt: null,
      supersededByCode: false,
      archived: false
    });
  }

  // Steps 5+6 — append to engine + install TypeProposal/FieldProposal on
  // the new ns + stash the binding. Shared with the cluster listener and
  // cold-boot reconcile (multi-instance.ts) so the install order has one
  // source; it skips whatever a stranded attempt already installed.
  try {
    installHotAddedNamespace({
      ns,
      dataset: newDataset,
      registryStore: deps.registryStore,
      engine: controlEngine,
      edges: deps.edges,
      ...(deps.proposeCapability !== undefined && { proposeCapability: deps.proposeCapability }),
      ...(deps.indexCapability !== undefined && { indexCapability: deps.indexCapability }),
      ...(deps.registerProposalMutations !== undefined && {
        registerProposalMutations: deps.registerProposalMutations
      })
    });
  } finally {
    claimForRollback(deps, ns, controlEngine, args);
  }

  // Step 7 — mark applied=true via autoCRUD update
  const now = new Date();
  await writeInTx(controlBinding.registry, ctx, args, 'updateNamespaceProposal', {
    id: proposalId,
    applied: true,
    appliedAt: now
  });

  // Step 8 — NOTIFY peers once the row commits, so they can't observe a
  // half-applied state.
  await notifyAfterCommit(args, () => deps.pubsub.notify(CLUSTER_CHANNEL, ns));

  // Step 9 — return the applied row. autoCRUD's update returned `{ id }` on
  // the projection above; re-read so the downstream consumer sees every
  // field with the post-update state.
  const readBack = await args.dataset.read('NamespaceProposal', { id: proposalId });
  const rawRow = readBack.rows[0];
  if (!rawRow) {
    throw new Error(`NamespaceProposal row ${proposalId} not found after apply`);
  }
  return { ...rawRow, applied: true, appliedAt: now };
}

/**
 * Take the hot-added `ns` back off the engine if the caller's transaction
 * rolls back, so it cannot stay live and writable with no proposal row (whose
 * writes nothing would replay at boot). Runs only when this attempt holds a
 * hot-added binding, i.e. its `addNamespace` landed or it adopted a stranded
 * one. The claim is a token on the binding: a later attempt that adopts the
 * binding before this undo runs (the proposal lock is gone by then) replaces
 * the token, and this undo then leaves the namespace to it.
 */
function claimForRollback(
  deps: ProposeNamespaceResolverDeps,
  ns: string,
  engine: EngineHandle,
  args: ResolverArgs
): void {
  if (args.afterTx === undefined || !deps.registryStore.has(ns)) return;
  const binding = deps.registryStore.getBinding(ns);
  if (binding.hotAdded !== true) return;
  const claim = {};
  binding.claim = claim;
  const control = deps.registryStore.getBinding(deps.controlNamespace).dataset;
  args.afterTx(async ({ committed }) => {
    if (committed || !deps.registryStore.has(ns)) return;
    const current = deps.registryStore.getBinding(ns);
    if (current !== binding || current.claim !== claim) return;
    if (engine.namespaceState(ns) !== 'live') return;
    // Belt and braces: never remove a namespace a committed proposal stands behind.
    const standing = await control.read('NamespaceProposal', {
      where: { AND: [{ ns: { eq: ns } }, { archived: { eq: false } }, { applied: { eq: true } }] },
      limit: 1
    });
    if (standing.rows.length > 0) return;
    if (deps.registryStore.getBinding(ns) !== binding || binding.claim !== claim) return;
    engine.removeNamespace(ns);
    deps.registryStore.delete(ns);
  });
}
