import { describe, expectTypeOf, it } from 'vitest';
import type {
  CoordinatorPlugin,
  FilterOperatorDef,
  HttpMethod,
  KernelLifecycleContext,
  KernelMigration,
  KernelMigrationContext,
  KernelPlugin,
  KernelRouteClaim,
  McpToolRegistration,
  NamespaceDefinition,
  PluginLifecycleContext,
  PostWriteHook
} from '../src/index.js';

describe('KernelPlugin', () => {
  it('has the load-bearing fields', () => {
    expectTypeOf<KernelPlugin>().toMatchTypeOf<{
      name: string;
      contractVersion: string;
      migrations?: KernelMigration[];
      filterOperators?: Record<string, FilterOperatorDef>;
      kernelRoutes?: KernelRouteClaim[];
      mcpTools?: McpToolRegistration[];
      onKernelReady?: (ctx: KernelLifecycleContext) => void | Promise<void>;
    }>();
  });

  it('KernelMigration carries id, apply, optional rollback', () => {
    expectTypeOf<KernelMigration>().toMatchTypeOf<{
      id: string;
      apply: (ctx: KernelMigrationContext) => Promise<void>;
      rollback?: (ctx: KernelMigrationContext) => Promise<void>;
    }>();
  });

  it('KernelRouteClaim ties path/method/handler', () => {
    expectTypeOf<KernelRouteClaim>().toMatchTypeOf<{
      path: string;
      method: HttpMethod;
      handler: unknown; // HttpHandler is from server.ts; structural check enough
    }>();
  });
});

describe('CoordinatorPlugin v2.3 contract', () => {
  it('contractVersion is required', () => {
    expectTypeOf<CoordinatorPlugin>().toMatchTypeOf<{
      name: string;
      contractVersion: string;
    }>();
  });

  it('migrations field is removed', () => {
    type C = CoordinatorPlugin;
    type HasMigrations = 'migrations' extends keyof C ? true : false;
    expectTypeOf<HasMigrations>().toEqualTypeOf<false>();
  });
});

// Type hygiene: (a) FilterOperatorDef carries no name (its Record key is
// canonical), (b) KernelLifecycleContext and PluginLifecycleContext must
// not be structurally interchangeable.
describe('v2.2-substrate type hygiene', () => {
  it('FilterOperatorDef no longer carries a name field (Record key is canonical)', () => {
    type Op = FilterOperatorDef;
    type HasName = 'name' extends keyof Op ? true : false;
    expectTypeOf<HasName>().toEqualTypeOf<false>();
  });

  it('FilterOperatorDef still carries validate + execute', () => {
    expectTypeOf<FilterOperatorDef>().toMatchTypeOf<{
      validate: (value: unknown) => { ok: true; value: unknown } | { ok: false; reason: string };
      execute: (value: unknown, context: unknown) => Promise<unknown>;
    }>();
  });

  it('KernelLifecycleContext is NOT assignable to PluginLifecycleContext', () => {
    type SubExtendsCoord = KernelLifecycleContext extends PluginLifecycleContext ? true : false;
    expectTypeOf<SubExtendsCoord>().toEqualTypeOf<false>();
  });

  it('PluginLifecycleContext is NOT assignable to KernelLifecycleContext', () => {
    type CoordExtendsSub = PluginLifecycleContext extends KernelLifecycleContext ? true : false;
    expectTypeOf<CoordExtendsSub>().toEqualTypeOf<false>();
  });

  it('lifecycle discriminant is the differentiator (kernel vs coordinator)', () => {
    expectTypeOf<KernelLifecycleContext['lifecycle']>().toEqualTypeOf<'kernel'>();
    expectTypeOf<PluginLifecycleContext['lifecycle']>().toEqualTypeOf<'coordinator'>();
  });
});

// contributePostWrites on KernelPlugin
describe('KernelPlugin.contributePostWrites (Task 3)', () => {
  it('contributePostWrites is optional on KernelPlugin', () => {
    type HasSlot = 'contributePostWrites' extends keyof KernelPlugin ? true : false;
    expectTypeOf<HasSlot>().toEqualTypeOf<true>();
  });

  it('contributePostWrites accepts NamespaceDefinition and returns Record<string, PostWriteHook>', () => {
    expectTypeOf<KernelPlugin>().toMatchTypeOf<{
      contributePostWrites?: (namespace: NamespaceDefinition) => Record<string, PostWriteHook>;
    }>();
  });

  it('PostWriteHook alias is exported and returns Promise<void>', () => {
    expectTypeOf<ReturnType<PostWriteHook>>().toEqualTypeOf<Promise<void>>();
  });

  it('compile-only: a concrete plugin implementing contributePostWrites type-checks', () => {
    // Compile-only: confirm contributePostWrites accepts a NamespaceDefinition
    // and returns Record<string, PostWriteHook>. No runtime assertion.
    const _testPlugin: KernelPlugin = {
      name: 'test',
      contractVersion: '^2.3.0',
      contributePostWrites(ns: NamespaceDefinition): Record<string, PostWriteHook> {
        void ns;
        return {};
      }
    };
    void _testPlugin;
  });
});
