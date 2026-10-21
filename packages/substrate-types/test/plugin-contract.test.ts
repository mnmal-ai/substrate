import { describe, expect, it } from 'vitest';
import type {
  KernelNamespaceContribution,
  KernelPlugin,
  NamespaceConfig,
  RegistryEntry,
  VirtualMutationDef,
  VirtualTypeDef
} from '../src/index.js';

describe('kernelNamespace contribution contract', () => {
  it('compiles a minimal virtual-namespace contribution and a virtual NamespaceConfig', () => {
    const typeDef: VirtualTypeDef = {
      fields: { id: { kind: 'scalar', type: 'string' } },
      resolver: async () => []
    };
    const mutationDef: VirtualMutationDef = {
      resolver: async () => null
    };
    const contribution: KernelNamespaceContribution = {
      namespace: 'recall',
      types: { Hit: typeDef },
      mutations: { boost: mutationDef }
    };
    const plugin: KernelPlugin = {
      name: 'test-sub',
      contractVersion: '^2.3.0',
      kernelNamespace: contribution
    };
    expect(plugin.kernelNamespace?.namespace).toBe('recall');

    // Registry is a fully structural interface — construct a stub literal.
    const cfg: NamespaceConfig = {
      registry: {
        register() {},
        replace() {},
        get: () => undefined,
        has: () => false,
        all: () => new Map<string, RegistryEntry>().entries()
      },
      virtual: true
    };
    expect(cfg.virtual).toBe(true);
  });
});
