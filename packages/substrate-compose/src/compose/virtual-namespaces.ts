/**
 * Substrate virtual-namespace claims. Each substrate plugin may claim ONE virtual namespace carrying resolver-backed types +
 * mutations. No dataset is allocated — the engine's virtual exemption
 * dispatches these without storage. Collisions refuse boot: substrate-vs-
 * substrate within this loop, coordinator-vs-substrate against the
 * already-populated namespaces map, and the engine-reserved _system name.
 */

import { type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import type { KernelPlugin } from '@mnmal-ai/substrate-types';
import { SYSTEM_NAMESPACE } from '../_system/index.js';

export function installVirtualNamespaces(
  namespaces: Map<string, NamespaceConfig>,
  kernelPlugins: Array<KernelPlugin> | undefined,
  routeMetric: (name: string, payload?: unknown) => void
): void {
  const virtualClaims = new Map<string, string>(); // namespace → plugin name
  for (const sub of kernelPlugins ?? []) {
    const claim = sub.kernelNamespace;
    if (claim === undefined) continue;
    const priorClaimant = virtualClaims.get(claim.namespace);
    const collidesWith =
      priorClaimant !== undefined
        ? `kernel plugin '${priorClaimant}'`
        : claim.namespace === SYSTEM_NAMESPACE
          ? `the engine-reserved '${SYSTEM_NAMESPACE}' namespace`
          : namespaces.has(claim.namespace)
            ? 'a coordinator namespace'
            : null;
    if (collidesWith !== null) {
      throw new Error(
        `virtual_namespace_collision: kernel plugin '${sub.name}' claims namespace '${claim.namespace}', which is already registered by ${collidesWith}`
      );
    }
    const registry = new Registry();
    // Re-throw within-claim duplicates (type + mutation sharing a name) with
    // the plugin + namespace context — a bare DuplicateRegistration names the
    // symbol but not which substrate plugin to fix.
    const registerOrExplain = (name: string, input: Parameters<Registry['register']>[1]): void => {
      try {
        registry.register(name, input);
      } catch (err) {
        throw new Error(
          `virtual_namespace_collision: kernel plugin '${sub.name}' declares '${name}' more than once in namespace '${claim.namespace}' (${err instanceof Error ? err.message : String(err)})`
        );
      }
    };
    for (const [typeName, def] of Object.entries(claim.types ?? {})) {
      registerOrExplain(typeName, { resolver: def.resolver, kind: 'type', fields: def.fields });
    }
    for (const [mutName, def] of Object.entries(claim.mutations ?? {})) {
      registerOrExplain(mutName, {
        resolver: def.resolver,
        kind: 'mutation',
        ...(def.params !== undefined ? { params: def.params } : {})
      });
    }
    virtualClaims.set(claim.namespace, sub.name);
    namespaces.set(claim.namespace, { registry, virtual: true });
    routeMetric('kernel_namespace_installed', { plugin: sub.name, namespace: claim.namespace });
  }
}
