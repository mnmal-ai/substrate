/**
 * Multi-instance invalidation helpers for substrate-proposals.
 *
 * `setupNamespaceListener` wires a PubSub LISTEN handler so that when another
 * instance applies a proposal (and emits a NOTIFY), this instance immediately
 * re-applies it to its own live Registry.
 *
 * `reconcileNamespace` replays all applied=true proposals at startup so a
 * freshly-booted instance is immediately consistent without waiting for a NOTIFY.
 *
 * `applyProposalFromNotification` is the shared "look up the row, apply if
 * needed" helper used by both the listener and any ad-hoc invalidation path.
 */

import type {
  Dataset,
  DropParticipant,
  EdgesStore,
  EngineHandle,
  Registry,
  Row
} from '@mnmal-ai/substrate-types';
import { applyFieldProposal, applyTypeProposal } from './apply.js';
import type { PubSub } from './config.js';
import { isProposableNamespace } from './control-plane.js';
import type { FieldSpecJson } from './field-spec-json.js';
import { defineProposalTypes } from './namespace.js';
import { CLUSTER_CHANNEL } from './propose-namespace-resolver.js';
import type { RegistryStore } from './registry-store.js';

export interface SetupListenerArgs {
  namespace: string;
  channel: string;
  pubsub: PubSub;
  registryStore: RegistryStore;
}

export async function setupNamespaceListener(args: SetupListenerArgs): Promise<void> {
  await args.pubsub.listen(args.channel, async (payload) => {
    // A throw here would end the listener. Boot replay reports the same row through onSkip.
    await applyProposalFromNotification({
      namespace: args.namespace,
      proposalId: payload,
      registryStore: args.registryStore
    }).catch(() => {});
  });
}

export interface ApplyFromNotificationArgs {
  namespace: string;
  proposalId: string;
  registryStore: RegistryStore;
}

export async function applyProposalFromNotification(
  args: ApplyFromNotificationArgs
): Promise<void> {
  const binding = args.registryStore.getBinding(args.namespace);

  // Try TypeProposal first, then FieldProposal
  const typeHit = await binding.dataset.read('TypeProposal', { id: args.proposalId });
  if (typeHit.rows.length > 0) {
    const row = typeHit.rows[0] as Row;
    if (row.applied === true && !binding.registry.get(row.typeName as string)) {
      const fields = JSON.parse(row.fieldsJson as string) as Record<string, FieldSpecJson>;
      applyTypeProposal({
        namespace: args.namespace,
        typeName: row.typeName as string,
        fields,
        registryStore: args.registryStore,
        dataset: binding.dataset,
        edges: binding.edges
      });
    }
    return;
  }

  const fieldHit = await binding.dataset.read('FieldProposal', { id: args.proposalId });
  if (fieldHit.rows.length > 0) {
    const row = fieldHit.rows[0] as Row;
    if (row.applied === true) {
      const entry = binding.registry.get(row.targetType as string);
      if (entry && fieldNeedsReplay(entry, row)) {
        const fieldSpec = JSON.parse(row.fieldSpecJson as string) as FieldSpecJson;
        applyFieldProposal({
          namespace: args.namespace,
          targetType: row.targetType as string,
          fieldName: row.fieldName as string,
          fieldSpec,
          registryStore: args.registryStore,
          dataset: binding.dataset,
          edges: binding.edges
        });
      }
    }
  }
}

export interface ReconcileArgs {
  namespace: string;
  registryStore: RegistryStore;
  /** Told about each row that could not be replayed; the row is skipped, not fatal. */
  onSkip?: (row: Row, err: unknown) => void;
}

/**
 * A field proposal needs replaying when its field is absent, or when it
 * narrowed an enum: the type was registered with the wider spec, and the
 * narrowing exists only in the proposal row.
 */
function fieldNeedsReplay(entry: { fields: Record<string, unknown> }, row: Row): boolean {
  return !((row.fieldName as string) in entry.fields) || typeof row.valueMapJson === 'string';
}

export async function reconcileNamespace(args: ReconcileArgs): Promise<void> {
  const binding = args.registryStore.getBinding(args.namespace);

  // TypeProposals first so field additions find their types.
  const typeRows = await binding.dataset.read('TypeProposal', {
    where: {
      AND: [
        { applied: { eq: true } },
        { supersededByCode: { eq: false } },
        { archived: { eq: false } }
      ]
    },
    limit: 10000
  });
  for (const row of typeRows.rows) {
    if (binding.registry.get(row.typeName as string)) continue;
    try {
      const fields = JSON.parse(row.fieldsJson as string) as Record<string, FieldSpecJson>;
      applyTypeProposal({
        namespace: args.namespace,
        typeName: row.typeName as string,
        fields,
        registryStore: args.registryStore,
        dataset: binding.dataset,
        edges: binding.edges
      });
    } catch (err) {
      args.onSkip?.(row, err);
    }
  }

  const fieldRows = await binding.dataset.read('FieldProposal', {
    where: {
      AND: [
        { applied: { eq: true } },
        { supersededByCode: { eq: false } },
        { archived: { eq: false } }
      ]
    },
    // Oldest first, so successive narrowings of one field land in order.
    orderBy: [{ appliedAt: 'asc' }],
    limit: 10000
  });
  for (const row of fieldRows.rows) {
    const entry = binding.registry.get(row.targetType as string);
    if (!entry || !fieldNeedsReplay(entry, row)) continue;
    try {
      const fieldSpec = JSON.parse(row.fieldSpecJson as string) as FieldSpecJson;
      applyFieldProposal({
        namespace: args.namespace,
        targetType: row.targetType as string,
        fieldName: row.fieldName as string,
        fieldSpec,
        registryStore: args.registryStore,
        dataset: binding.dataset,
        edges: binding.edges
      });
    } catch (err) {
      args.onSkip?.(row, err);
    }
  }
}

export interface InstallHotAddedNamespaceArgs {
  ns: string;
  /** Capability that writes to the proposal record types need; see `defineProposalTypes`. */
  proposeCapability?: string;
  dataset: Dataset;
  registryStore: RegistryStore;
  engine: EngineHandle;
  edges: EdgesStore;
  /**
   * Optional callback the plugin uses to register `propose_type` /
   * `propose_field` mutations onto the new ns's registry. Closed over the
   * plugin's pubsub + policy + ownedNamespaces so `multi-instance.ts` doesn't
   * need to import resolver factories or substrate-policy directly. When omitted
   * (resolver-direct test harnesses that don't go through the plugin), only
   * the autoCRUD types are installed — `propose_type` won't be reachable on
   * the hot-added ns.
   *
   * Synchronous by contract — runs during install, no await.
   */
  registerProposalMutations?: (registerArgs: {
    namespace: string;
    dataset: Dataset;
    edges: EdgesStore;
    registry: ReturnType<EngineHandle['createRegistry']>;
  }) => void;
}

/**
 * Shared install path for a hot-added namespace. Three call sites use this:
 *   - `setupClusterNamespaceListener` (NOTIFY-triggered install on a peer)
 *   - `reconcileClusterNamespaces` (cold-boot replay of applied=true rows)
 *   - `makeProposeNamespaceResolver` (the original propose_namespace mutation)
 *
 * Resumable: when `registryStore` already binds `ns` (an earlier install
 * failed part-way), the engine add is skipped and the existing binding is
 * completed, registering only the entries not yet present. Uses
 * `engine.createRegistry()` so the plugin stays zero-runtime-dep on substrate-core.
 *
 * The listener and reconcile skip a bound ns before calling; the resolver
 * calls through to resume a stranded proposal.
 *
 * @throws Error when `ns` is not a name propose_namespace accepts (a replayed
 *   row is caller-written data), from `engine.addNamespace` when the engine
 *   already holds an unbound `ns`, or from `registerProposalMutations`
 */
export function installHotAddedNamespace(args: InstallHotAddedNamespaceArgs): void {
  if (!isProposableNamespace(args.ns)) {
    throw new Error(`refusing to install ${JSON.stringify(args.ns)}: not a proposable namespace`);
  }
  let binding = args.registryStore.has(args.ns)
    ? args.registryStore.getBinding(args.ns)
    : undefined;
  if (binding === undefined) {
    const newRegistry = args.engine.createRegistry();
    args.engine.addNamespace(args.ns, { registry: newRegistry });
    binding = {
      registry: newRegistry,
      dataset: args.dataset,
      edges: args.edges,
      engine: args.engine,
      invalidateSchemaCaches: () => args.engine.invalidateSchemaCaches(args.ns),
      hotAdded: true
    };
    args.registryStore.set(args.ns, binding);
  }
  const registry = skipRegistered(binding.registry);
  defineProposalTypes(args.ns, args.proposeCapability).install({
    registry,
    dataset: binding.dataset,
    edges: binding.edges
  });
  if (args.registerProposalMutations !== undefined) {
    args.registerProposalMutations({
      namespace: args.ns,
      dataset: binding.dataset,
      edges: binding.edges,
      registry
    });
  }
}

/** A view of `registry` whose `register` is a no-op for names already present. */
function skipRegistered(registry: Registry): Registry {
  return {
    register: (key, input): void => {
      if (!registry.has(key)) registry.register(key, input);
    },
    replace: (key, input): void => registry.replace(key, input),
    get: (key) => registry.get(key),
    has: (key) => registry.has(key),
    all: () => registry.all(),
    ...(registry.unregister !== undefined && {
      unregister: (key): void => registry.unregister?.(key)
    }),
    get epoch(): number | undefined {
      return registry.epoch;
    }
  };
}

export interface SetupClusterListenerArgs {
  proposeCapability?: string;
  pubsub: PubSub;
  registryStore: RegistryStore;
  engine: EngineHandle;
  datasetFor: (ns: string) => Dataset | undefined;
  edges: EdgesStore;
  /**
   * Optional metric sink — invoked when a peer broadcasts a ns this host
   * can't see locally (datasetFor returns undefined). Without this, the
   * silent-skip is invisible to operators; with it, the host emits
   * `_system_proposals.cluster_skip_no_dataset` with the offending ns name.
   * Caller in index.ts onStart passes ctx.metric.
   */
  metric?: (name: string, payload?: unknown) => void;
  /** See InstallHotAddedNamespaceArgs.registerProposalMutations. */
  registerProposalMutations?: InstallHotAddedNamespaceArgs['registerProposalMutations'];
}

/**
 * Subscribe to the cluster-wide namespace channel (`_substrate_proposals_cluster`).
 *
 * When a peer instance applies a `propose_namespace` mutation, it fires a
 * NOTIFY with the new ns name. This handler installs the ns into the local
 * engine + registers proposal CRUD types + stashes the binding so subsequent
 * per-ns NOTIFYs (TypeProposal / FieldProposal applies) can find a registry.
 *
 * Idempotency: if `registryStore.has(ns)` is already true, no-op. Covers
 * cold-boot reconcile races and accidental re-broadcasts. The check
 * runs BEFORE `engine.addNamespace`, whose collision semantics would otherwise
 * throw — and throwing in a NOTIFY handler kills the listener.
 *
 * Race-window assumption: NOTIFY delivery is serial per channel — pg LISTEN
 * guarantees this; the test's LoopbackPubSub honors it (synchronous await
 * loop). A future async-fanout PubSub would race the has/set window and
 * need a lock.
 *
 * If the ns is broadcast but the local host hasn't provisioned a dataset for
 * it (hosts diverge on dataset registration), the handler skips and emits
 * `_system_proposals.cluster_skip_no_dataset` via `args.metric`.
 * Throwing in a NOTIFY handler tears down the LISTEN connection, so a metric
 * is the only way to surface this without losing the listener.
 */
export async function setupClusterNamespaceListener(args: SetupClusterListenerArgs): Promise<void> {
  await args.pubsub.listen(CLUSTER_CHANNEL, async (ns) => {
    if (args.registryStore.has(ns)) return;
    const dataset = args.datasetFor(ns);
    if (dataset === undefined) {
      // Peer added a ns this host can't see locally — host misconfiguration.
      // Surface via metric (throwing in a NOTIFY handler kills the listener).
      args.metric?.('_system_proposals.cluster_skip_no_dataset', { ns });
      return;
    }
    try {
      installHotAddedNamespace({
        ns,
        dataset,
        registryStore: args.registryStore,
        engine: args.engine,
        edges: args.edges,
        ...(args.proposeCapability !== undefined && { proposeCapability: args.proposeCapability }),
        ...(args.registerProposalMutations !== undefined && {
          registerProposalMutations: args.registerProposalMutations
        })
      });
    } catch (err) {
      args.metric?.('_system_proposals.cluster_skip_invalid', {
        ns,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
}

export interface ReconcileClusterArgs {
  proposeCapability?: string;
  controlNamespace: string;
  registryStore: RegistryStore;
  engine: EngineHandle;
  datasetFor: (ns: string) => Dataset | undefined;
  edges: EdgesStore;
  /** See InstallHotAddedNamespaceArgs.registerProposalMutations. */
  registerProposalMutations?: InstallHotAddedNamespaceArgs['registerProposalMutations'];
  /** Told about each row that could not be installed; the row is skipped, not fatal. */
  onSkip?: (row: Row, err: unknown) => void;
}

/**
 * Cold-boot replay of applied=true NamespaceProposal rows from the control-plane
 * dataset. For each row whose ns isn't already in registryStore (idempotent
 * against partial-replay states) and whose dataset is provisioned locally,
 * install it into the engine + register proposal CRUD types + set binding.
 *
 * Returns the list of namespaces actually added so the caller can extend its
 * per-ns reconcile pass to cover them too — TypeProposals proposed for
 * hot-added namespaces before restart need to be replayed alongside the
 * static-ownedNamespace TypeProposals.
 *
 * Mirrors setupClusterNamespaceListener's per-ns install path.
 *
 * Silently skips a row whose dataset the host has not provisioned (the
 * cluster listener's misconfig case): throwing would tear down boot. Unlike
 * the listener, no metric is emitted.
 */
export async function reconcileClusterNamespaces(args: ReconcileClusterArgs): Promise<string[]> {
  const controlBinding = args.registryStore.getBinding(args.controlNamespace);
  const rows = await controlBinding.dataset.read('NamespaceProposal', {
    where: { AND: [{ applied: { eq: true } }, { archived: { eq: false } }] },
    limit: 10000
  });
  const added: string[] = [];
  for (const row of rows.rows) {
    const ns = row.ns as string;
    if (args.registryStore.has(ns)) continue;
    const dataset = args.datasetFor(ns);
    if (dataset === undefined) continue;
    try {
      installHotAddedNamespace({
        ns,
        dataset,
        registryStore: args.registryStore,
        engine: args.engine,
        edges: args.edges,
        ...(args.proposeCapability !== undefined && { proposeCapability: args.proposeCapability }),
        ...(args.registerProposalMutations !== undefined && {
          registerProposalMutations: args.registerProposalMutations
        })
      });
    } catch (err) {
      args.onSkip?.(row, err);
      continue;
    }
    added.push(ns);
  }
  return added;
}

/** Peers are told on this channel that a hot-added namespace was dropped. */
export const CLUSTER_DROP_CHANNEL = '_substrate_proposals_cluster_drop';

/** True when `ns` is a namespace this plugin hot-added and still holds. */
function isHotAdded(registryStore: RegistryStore, ns: string): boolean {
  return registryStore.has(ns) && registryStore.getBinding(ns).hotAdded === true;
}

/**
 * Drop participant: inside the drop's own transaction, archive every
 * NamespaceProposal row for the dropped namespace, so boot replay does not
 * reinstall it and the name stays reserved (`namespace_retired`). Decided from
 * the control plane, not this process's bindings: only a proposed namespace
 * has rows. A throw rolls the drop back.
 */
export function namespaceDropParticipant(controlNamespace: string): DropParticipant {
  return {
    namespaces: [controlNamespace],
    async onDrop(ns, datasetFor) {
      const control = datasetFor(controlNamespace);
      for (;;) {
        const standing = await control.read('NamespaceProposal', {
          where: { AND: [{ ns: { eq: ns } }, { archived: { eq: false } }] },
          limit: 500
        });
        if (standing.rows.length === 0) return;
        await control.write(
          'NamespaceProposal',
          standing.rows.map((row) => ({ ...row, archived: true }))
        );
      }
    }
  };
}

export interface RetireDroppedNamespaceArgs {
  ns: string;
  registryStore: RegistryStore;
  engine: EngineHandle;
  pubsub: PubSub;
}

/**
 * After a drop has committed (its rows archived by the participant above):
 * take a hot-added namespace off this engine and tell peers to do the same.
 */
export async function retireDroppedNamespace(args: RetireDroppedNamespaceArgs): Promise<void> {
  if (!isHotAdded(args.registryStore, args.ns)) return;
  args.engine.removeNamespace(args.ns);
  args.registryStore.delete(args.ns);
  await args.pubsub.notify(CLUSTER_DROP_CHANNEL, args.ns);
}

export interface SetupClusterDropListenerArgs {
  controlNamespace: string;
  registryStore: RegistryStore;
  engine: EngineHandle;
  pubsub: PubSub;
  metric?: (name: string, payload?: unknown) => void;
}

/**
 * Take a peer-dropped hot-added namespace off this engine too. The message is
 * only a hint: the namespace is removed only when no live NamespaceProposal
 * row stands behind it in the shared control plane.
 */
export async function setupClusterDropListener(args: SetupClusterDropListenerArgs): Promise<void> {
  await args.pubsub.listen(CLUSTER_DROP_CHANNEL, async (ns) => {
    const { registryStore } = args;
    if (!isHotAdded(registryStore, ns)) return;
    try {
      const control = registryStore.getBinding(args.controlNamespace).dataset;
      const standing = await control.read('NamespaceProposal', {
        where: {
          AND: [{ ns: { eq: ns } }, { archived: { eq: false } }, { applied: { eq: true } }]
        },
        limit: 1
      });
      if (standing.rows.length > 0) {
        args.metric?.('_system_proposals.cluster_drop_ignored', { ns });
        return;
      }
      args.engine.removeNamespace(ns);
      registryStore.delete(ns);
    } catch (err) {
      // A throw here would end the listener.
      args.metric?.('_system_proposals.cluster_drop_failed', {
        ns,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
}
