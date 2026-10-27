/**
 * @mnmal-ai/substrate-proposals — public plugin factory.
 *
 * `createProposalsPlugin` wires together:
 *   - the reserved control-plane namespace (`_system_proposals`) housing the
 *     NamespaceProposal autoCRUD type + the propose_namespace mutation
 *   - one NamespaceDefinition per user-facing owned namespace (TypeProposal +
 *     FieldProposal autoCRUD + propose_type + propose_field mutations)
 *   - a shared RegistryStore closed over by all mutation resolvers so
 *     apply-proposal + reconcile + cluster-listener paths can reach the live
 *     registry at runtime
 *   - a policy gate derived from config.proposeCapability (defaults to 'substrate.propose')
 *   - `propose_index` on the control plane, for indexes of any namespace, gated
 *     by config.indexCapability (defaults to 'substrate.index')
 *
 * onStart wires the engine handle into each binding, replays applied proposals
 * via reconcileNamespace, and subscribes to per-ns + cluster-wide LISTEN/NOTIFY
 * channels for multi-instance coherence.
 */

import type {
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  NamespaceDefinition,
  NamespaceInstallContext,
  PluginLifecycleContext,
  Registry
} from '@mnmal-ai/substrate-types';
import {
  DEFAULT_INDEX_CAPABILITY,
  DEFAULT_PROPOSE_CAPABILITY,
  makeIndexPolicy,
  makeProposePolicy
} from './capability.js';
import type { ProposalsPluginConfig } from './config.js';
import { CONTROL_NAMESPACE, defineControlPlaneTypes } from './control-plane.js';
import { storageSettled } from './engine-write.js';
import {
  namespaceDropParticipant,
  reconcileClusterNamespaces,
  reconcileNamespace,
  retireDroppedNamespace,
  setupClusterDropListener,
  setupClusterNamespaceListener,
  setupNamespaceListener
} from './multi-instance.js';
import { defineProposalTypes } from './namespace.js';
import { buildOnboardBody, registerOnboardRoute } from './onboard.js';
import { makeProposeFieldResolver } from './propose-field-resolver.js';
import { makeProposeIndexResolver } from './propose-index-resolver.js';
import { makeProposeNamespaceResolver } from './propose-namespace-resolver.js';
import { makeProposeTypeResolver } from './propose-type-resolver.js';
import { RegistryStore } from './registry-store.js';

export type { ProposalsPluginConfig, PubSub } from './config.js';
export { createNoopPubSub } from './config.js';
export { storageSettled } from './engine-write.js';
export { ProposalError } from './errors.js';
export type {
  CrossRefSpec,
  FieldSpecJson,
  ListSpec,
  ScalarSpec,
  StructSpec
} from './field-spec-json.js';

export function createProposalsPlugin(config: ProposalsPluginConfig): CoordinatorPlugin {
  // Reject collision: the control-plane ns name is reserved.
  if (config.ownedNamespaces.includes(CONTROL_NAMESPACE)) {
    throw new Error(
      `'${CONTROL_NAMESPACE}' is the reserved control-plane namespace and cannot appear in ownedNamespaces — remove it from your ownedNamespaces config`
    );
  }

  const ownedNamespaces = new Set(config.ownedNamespaces);
  const registryStore = new RegistryStore();
  const capability = config.proposeCapability ?? DEFAULT_PROPOSE_CAPABILITY;
  const policy = makeProposePolicy(capability);
  const indexCapability = config.indexCapability ?? DEFAULT_INDEX_CAPABILITY;

  // Late-bound dataset lookup for hot-added namespaces. An explicit
  // `config.datasetFor` wins; otherwise onStart swaps in the engine handle's
  // `datasetFor`. Resolvers must call through a wrapper `(ns) => lookupDataset(ns)`
  // so the reassignment reaches them.
  let lookupDataset: (ns: string) => Dataset | undefined =
    config.datasetFor ?? ((): undefined => undefined);

  /**
   * Shared resolver-registration helper. Used at static-ns install time AND
   * at hot-add time (from propose_namespace + cluster listener + cold-boot
   * reconcile via the `registerProposalMutations` seam in multi-instance.ts).
   * Single-source because divergence makes propose_type silently unreachable
   * on hot-added namespaces.
   */
  const registerProposalMutations = (registerArgs: {
    namespace: string;
    dataset: Dataset;
    edges: EdgesStore;
    registry: Registry;
  }): void => {
    const deps = {
      namespace: registerArgs.namespace,
      ownedNamespaces,
      registryStore,
      dataset: registerArgs.dataset,
      edges: registerArgs.edges,
      pubsub: config.pubsub,
      channelFor: (n: string): string => `_substrate_proposals_${n}`
    };
    registerArgs.registry.register('propose_type', {
      kind: 'mutation',
      resolver: makeProposeTypeResolver(deps),
      policy
    });
    registerArgs.registry.register('propose_field', {
      kind: 'mutation',
      resolver: makeProposeFieldResolver(deps),
      policy
    });
  };

  // Control-plane ns hosts the NamespaceProposal autoCRUD type. Installed first
  // so reconcile / propose_namespace can rely on it before any user-facing ns.
  const controlNsDef: NamespaceDefinition = {
    namespace: CONTROL_NAMESPACE,
    install(ctx: NamespaceInstallContext): void {
      registryStore.set(CONTROL_NAMESPACE, {
        registry: ctx.registry,
        dataset: ctx.dataset,
        edges: ctx.edges
      });
      defineControlPlaneTypes(capability).install(ctx);

      // propose_namespace mutation — runtime namespace creation. Resolver factory captures `registryStore` at install time; the engine
      // handle is late-bound by `onStart` (see below) so the resolver can call
      // `controlEngine.addNamespace` and route create/update writes through
      // autoCRUD.
      ctx.registry.register('propose_namespace', {
        kind: 'mutation',
        resolver: makeProposeNamespaceResolver({
          controlNamespace: CONTROL_NAMESPACE,
          registryStore,
          // Wrapper closes over the late-bound `lookupDataset` so onStart's
          // swap to `engine.datasetFor` takes effect on every resolver call.
          datasetFor: (ns: string): Dataset | undefined => lookupDataset(ns),
          edges: ctx.edges,
          pubsub: config.pubsub,
          proposeCapability: capability,
          indexCapability,
          registerProposalMutations
        }),
        policy
      });

      // propose_index — index changes on any namespace's types, so it lives on
      // the control plane and names its target in `params.namespace`.
      ctx.registry.register('propose_index', {
        kind: 'mutation',
        resolver: makeProposeIndexResolver({
          registryStore,
          datasetFor: (ns: string): Dataset | undefined => lookupDataset(ns),
          pubsub: config.pubsub,
          channelFor: (n: string): string => `_substrate_proposals_${n}`
        }),
        policy: makeIndexPolicy(indexCapability)
      });
    }
  };

  const userNsDefs: NamespaceDefinition[] = config.ownedNamespaces.map(
    (ns): NamespaceDefinition => ({
      namespace: ns,
      install(ctx: NamespaceInstallContext): void {
        // Stash the full binding so mutation resolvers + reconcile can reach it later.
        registryStore.set(ns, { registry: ctx.registry, dataset: ctx.dataset, edges: ctx.edges });

        // Register TypeProposal + FieldProposal autoCRUD types.
        defineProposalTypes(ns, capability, indexCapability).install(ctx);

        // Register propose_type + propose_field mutations via the shared
        // helper (single-source with the hot-add path).
        registerProposalMutations({
          namespace: ns,
          dataset: ctx.dataset,
          edges: ctx.edges,
          registry: ctx.registry
        });
      }
    })
  );

  const namespaces: NamespaceDefinition[] = [controlNsDef, ...userNsDefs];

  return {
    name: 'substrate-proposals',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces,
    onboardInstructions: buildOnboardBody(config.ownedNamespaces) as unknown as Record<
      string,
      unknown
    >,
    routes: (router, ctx): void => {
      registerOnboardRoute(router, ctx, config.ownedNamespaces);
    },
    async onStart(ctx: PluginLifecycleContext): Promise<void> {
      // Wire control-plane FIRST so propose_namespace can use the engine
      // handle immediately when called. The control-plane install registered
      // the propose_namespace resolver above, but the resolver closure reads
      // `controlBinding.engine` at call time — populating it here is what
      // makes the autoCRUD-routed create/update writes work.
      registryStore.setInvalidator(CONTROL_NAMESPACE, () =>
        ctx.engine.invalidateSchemaCaches(CONTROL_NAMESPACE)
      );
      registryStore.setEngine(CONTROL_NAMESPACE, ctx.engine);

      // Without an explicit `config.datasetFor`, fall back to the engine
      // handle's `datasetFor`.
      if (config.datasetFor === undefined) {
        lookupDataset = (ns: string): Dataset | undefined => ctx.engine.datasetFor(ns);
      }

      // Cold-boot: replay applied=true NamespaceProposal rows so hot-added
      // namespaces survive restarts. Returns the list of additions so the
      // per-ns reconcile loop below iterates the union of static
      // ownedNamespaces + hot-added ones, so TypeProposals in hot-added
      // namespaces are replayed too.
      const controlBinding = registryStore.getBinding(CONTROL_NAMESPACE);
      const hotAddedNamespaces = await reconcileClusterNamespaces({
        controlNamespace: CONTROL_NAMESPACE,
        registryStore,
        engine: ctx.engine,
        datasetFor: lookupDataset,
        edges: controlBinding.edges,
        proposeCapability: capability,
        indexCapability,
        registerProposalMutations,
        onSkip: (row, err) =>
          ctx.metric('_system_proposals.replay_skipped', {
            namespace: CONTROL_NAMESPACE,
            id: row.id,
            error: err instanceof Error ? err.message : String(err)
          })
      });

      const allNs = [...config.ownedNamespaces, ...hotAddedNamespaces];
      for (const ns of allNs) {
        // Wire schema-cache invalidation BEFORE reconcile / any later
        // applyType / applyField call.
        registryStore.setInvalidator(ns, () => ctx.engine.invalidateSchemaCaches(ns));
        // Wire engine handle so propose_type / propose_field route TypeProposal
        // and FieldProposal writes through autoCRUD. Resolver factories
        // captured `registryStore` at install time, so this late-binding is the
        // mechanism that lets them reach the engine without re-construction.
        registryStore.setEngine(ns, ctx.engine);

        await reconcileNamespace({
          namespace: ns,
          registryStore,
          onSkip: (row, err) =>
            ctx.metric('_system_proposals.replay_skipped', {
              namespace: ns,
              id: row.id,
              error: err instanceof Error ? err.message : String(err)
            })
        });
        await setupNamespaceListener({
          namespace: ns,
          channel: `_substrate_proposals_${ns}`,
          pubsub: config.pubsub,
          registryStore
        });
        ctx.metric('_system_proposals.namespace_ready', { namespace: ns });
      }

      // Cluster-wide listener: when a peer instance applies propose_namespace,
      // install the new ns into THIS engine too. Edges store comes from the
      // control-plane binding (every install threads the same EdgesStore in
      // production).
      // A drop of a namespace this plugin hot-added: its proposal rows are
      // archived inside the drop's transaction, then once it commits the
      // namespace leaves this engine and peers are told.
      ctx.engine.addDropParticipant(namespaceDropParticipant(CONTROL_NAMESPACE));
      ctx.engine.onNamespaceTombstoned((ns) => {
        void retireDroppedNamespace({
          ns,
          registryStore,
          engine: ctx.engine,
          pubsub: config.pubsub
        }).catch((err: unknown) =>
          ctx.metric('_system_proposals.retire_failed', {
            ns,
            error: err instanceof Error ? err.message : String(err)
          })
        );
      });
      await setupClusterDropListener({
        controlNamespace: CONTROL_NAMESPACE,
        registryStore,
        engine: ctx.engine,
        pubsub: config.pubsub,
        metric: ctx.metric
      });

      await setupClusterNamespaceListener({
        pubsub: config.pubsub,
        registryStore,
        engine: ctx.engine,
        datasetFor: lookupDataset,
        edges: controlBinding.edges,
        metric: ctx.metric,
        proposeCapability: capability,
        indexCapability,
        registerProposalMutations
      });
    },
    // Replay and proposals prepare storage in the background; let it finish before the store closes.
    async onStop(): Promise<void> {
      await storageSettled();
    }
  };
}
