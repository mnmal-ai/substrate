import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Policy, RequestContext, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { field } from '../src/field.js';
import { defineNamespace, type TypeInput } from '../src/namespace.js';

function ctxFor(
  ns: string,
  // Defaults to a declared system actor: an unattributed write is refused,
  // and these tests are about the namespace, not about auth.
  identity: RequestContext['identity'] = {
    kind: 'system',
    id: 'test',
    grants: { '*': ['read', 'mutate'] }
  }
): Partial<RequestContext> {
  return { namespace: ns, identity };
}

describe('shortId auto-injection', () => {
  it('injects shortId into the fields registered on the type', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const ns = defineNamespace('app', {
      Todo: { fields: { title: field.string() } }
    });
    await ns.install({ registry, dataset, edges });

    const entry = registry.get('Todo');
    expect(entry).toBeDefined();
    expect(entry?.fields.shortId).toBeDefined();
    expect(entry?.fields.shortId).toMatchObject({ kind: 'scalar', type: 'number' });
  });

  it('injects shortId on every type in a multi-type namespace', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const ns = defineNamespace('app', {
      Foo: { fields: { a: field.string() } },
      Bar: { fields: { b: field.number() } }
    });
    await ns.install({ registry, dataset, edges });

    for (const typeName of ['Foo', 'Bar']) {
      const entry = registry.get(typeName);
      expect(entry?.fields.shortId, `${typeName} should have shortId`).toBeDefined();
      expect(entry?.fields.shortId).toMatchObject({ kind: 'scalar', type: 'number' });
    }
  });

  it('does not mutate the caller-supplied fields object', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const callerFields = { title: field.string() };
    const ns = defineNamespace('app', {
      Todo: { fields: callerFields }
    });
    await ns.install({ registry, dataset, edges });

    // Caller's object is unchanged — no shortId leaked back
    expect(Object.keys(callerFields)).toEqual(['title']);
  });

  it('injects shortId as readonly so autoCRUD + consumers can reject writes declaratively', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const ns = defineNamespace('app', {
      Todo: { fields: { title: field.string() } }
    });
    await ns.install({ registry, dataset, edges });

    const entry = registry.get('Todo');
    // Readonly is the declarative signal the create handler keys off.
    expect(entry?.fields.shortId).toMatchObject({
      kind: 'scalar',
      type: 'number',
      readonly: true
    });
  });

  it('throws if a plugin declares shortId explicitly (reserved name)', () => {
    expect(() =>
      defineNamespace('alt', {
        Foo: { fields: { shortId: field.string() } }
      })
    ).toThrow(/shortId.*reserved/i);
  });

  it('does NOT reserve shortId for autoCrud:false types (engine does not inject into them)', () => {
    // A plugin using autoCrud:false manages its own resolvers and field
    // lists; shortId injection never touches that type, so the reserved
    // check should not fire.
    expect(() =>
      defineNamespace('alt', {
        Manual: { fields: { shortId: field.string() }, autoCrud: false }
      })
    ).not.toThrow();
  });
});

describe('defineNamespace', () => {
  it('installs autoCRUD for every type and registers expected mutations', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const nsDef = defineNamespace('app', {
      Todo: { fields: { id: field.string(), title: field.string() } },
      Tag: { fields: { id: field.string(), name: field.string() } }
    });

    await nsDef.install({ registry, dataset, edges });

    expect(registry.has('Todo')).toBe(true);
    expect(registry.has('getTodo')).toBe(true);
    expect(registry.has('createTodo')).toBe(true);
    expect(registry.has('updateTodo')).toBe(true);
    expect(registry.has('deleteTodo')).toBe(true);
    expect(registry.has('Tag')).toBe(true);
    expect(registry.has('createTag')).toBe(true);
    // purge is opt-in — off by default.
    expect(registry.has('purgeTodo')).toBe(false);
    expect(registry.has('purgeTag')).toBe(false);
  });

  it('round-trips createTodo + query Todo through the engine', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const nsDef = defineNamespace('app', {
      Todo: { fields: { id: field.string(), title: field.string() } }
    });
    await nsDef.install({ registry, dataset, edges });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges
    });

    const mutEnv = await engine.mutate({
      frame: {
        'app/createTodo': {
          params: { id: '1', title: 'landed' },
          fields: { id: true, title: true }
        }
      },
      ctx: ctxFor('app')
    });
    expect(mutEnv.errors).toBeUndefined();

    const qEnv = await engine.query({
      frame: { 'app/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: ctxFor('app')
    });
    const rows = qEnv.data['app/Todo'] as Array<{ id: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('landed');
  });

  it('autoCrud: false skips that type entirely', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const nsDef = defineNamespace('app', {
      Todo: { fields: { id: field.string() } },
      SkipMe: { fields: { id: field.string() }, autoCrud: false }
    });
    await nsDef.install({ registry, dataset, edges });

    expect(registry.has('Todo')).toBe(true);
    expect(registry.has('SkipMe')).toBe(false);
    expect(registry.has('createSkipMe')).toBe(false);
  });

  it('purgeable: true installs the purge<T> mutation with admin gate', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const nsDef = defineNamespace('app', {
      Todo: { fields: { id: field.string() }, purgeable: true }
    });
    await nsDef.install({ registry, dataset, edges });

    expect(registry.has('purgeTodo')).toBe(true);

    // The default admin gate denies anonymous. We verify via engine.mutate
    // returning a policy-deny envelope entry rather than touching the dataset.
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges
    });
    const env = await engine.mutate({
      frame: { 'app/purgeTodo': { params: { id: '1' }, fields: { id: true } } },
      ctx: ctxFor('app')
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.path).toEqual(['app/purgeTodo']);
  });

  it('plugin-global policy composes with per-type policy via and()', async () => {
    const calls: string[] = [];
    const globalPolicy: Policy = (_ctx, _args) => {
      calls.push('global');
      return { allow: true };
    };
    const perTypePolicy: Policy = (_ctx, _args) => {
      calls.push('perType');
      return { allow: false, reason: 'type deny' };
    };

    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const nsDef = defineNamespace(
      'app',
      {
        Todo: { fields: { id: field.string() }, policy: perTypePolicy }
      },
      { policy: globalPolicy }
    );
    await nsDef.install({ registry, dataset, edges });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges
    });

    const env = await engine.query({
      frame: { 'app/Todo': { params: {}, fields: { id: true } } },
      ctx: ctxFor('app')
    });
    // `and(global, perType)` short-circuits on first deny — so the combined
    // gate must deny (perType deny wins), and the global must have been
    // evaluated first.
    expect(env.errors).toBeDefined();
    expect(calls[0]).toBe('global');
    expect(calls).toContain('perType');
  });
});

describe('NamespaceDefinition.types', () => {
  it('exposes the type definitions as a readable record', () => {
    const ns = defineNamespace('demo', {
      Memory: { fields: { name: field.string() } },
      Decision: { fields: { topic: field.string() } }
    });
    if (ns.types == null) throw new Error('expected ns.types to be populated');
    expect(Object.keys(ns.types)).toEqual(['Memory', 'Decision']);
    expect(ns.types.Memory?.fields).toBeDefined();
  });

  it('preserves embed metadata through the round-trip (Task 1 follow-up)', () => {
    const ns = defineNamespace('demo', {
      Memory: {
        fields: { name: field.string(), body: field.string() },
        embed: {
          source: (row: Row) => (typeof row.body === 'string' ? row.body : '')
        }
      }
    });
    if (ns.types == null) throw new Error('expected ns.types to be populated');
    expect(ns.types.Memory?.embed?.source).toBeDefined();
    expect(ns.types.Memory?.embed?.source({ id: 'x', body: 'hello' })).toBe('hello');
  });
});

describe('TypeInput.embed', () => {
  it('TypeInput accepts an embed slot (compile-time check)', () => {
    const input: TypeInput = {
      fields: { body: field.string() },
      embed: {
        source: (row) => (typeof row.body === 'string' ? row.body : '')
      }
    };
    // Ensure the source function is callable and returns the expected string.
    expect(input.embed?.source({ id: 'test-id', body: 'hello' })).toBe('hello');
    expect(input.embed?.source({ id: 'test-id', body: 42 })).toBe('');
  });

  it('defineNamespace accepts types with embed slot without error', () => {
    // The `embed` slot must be opaque to defineNamespace — stored, not
    // interpreted. This test confirms no validation logic rejects it.
    expect(() =>
      defineNamespace('demo', {
        Memory: {
          fields: { name: field.string(), body: field.string() },
          embed: {
            source: (row) => (typeof row.body === 'string' ? row.body : '')
          }
        }
      })
    ).not.toThrow();
  });

  it('defineNamespace without embed compiles and installs unchanged', async () => {
    // Regression guard: existing namespaces without embed must be unaffected.
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();

    const nsDef = defineNamespace('app', {
      Note: { fields: { title: field.string() } }
    });
    await nsDef.install({ registry, dataset, edges });

    expect(registry.has('Note')).toBe(true);
    expect(registry.has('createNote')).toBe(true);
  });
});

/**
 * Namespace-name validation. The per-namespace grant form is
 * `--ns notes:read,tasks:read+mutate`, and `:` only separates a namespace
 * from its capabilities if a namespace cannot CONTAIN one.
 */
describe('namespace names are validated (spec §3 Guard A)', () => {
  const ok = ['tasks', 'substrate_notes', 'tasks-run', '_system', 'a1'];
  for (const ns of ok) {
    it(`accepts '${ns}'`, () => {
      expect(() => defineNamespace(ns, { T: { fields: { a: field.string() } } })).not.toThrow();
    });
  }

  // The one that makes the grant grammar unambiguous.
  it("refuses a name containing ':' — it would collide with the grant separator", () => {
    expect(() => defineNamespace('notes:read', { T: { fields: { a: field.string() } } })).toThrow(
      /namespace/i
    );
  });

  it("refuses a name containing '/' — it would collide with the qualified frame key", () => {
    expect(() => defineNamespace('a/b', { T: { fields: { a: field.string() } } })).toThrow(
      /namespace/i
    );
  });

  it('refuses an empty name', () => {
    expect(() => defineNamespace('', { T: { fields: { a: field.string() } } })).toThrow(
      /namespace/i
    );
  });

  it('names the offending value, so the error is actionable', () => {
    let message = '';
    try {
      defineNamespace('notes:read', { T: { fields: { a: field.string() } } });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('notes:read');
  });
});

describe('defineNamespace annotations', () => {
  it('carries annotations onto the definition unchanged', () => {
    const def = defineNamespace(
      'ann',
      { T: { fields: { name: field.string() } } },
      {
        annotations: { nl: { liveStatus: { T: 'open' } } }
      }
    );
    expect(def.annotations).toEqual({ nl: { liveStatus: { T: 'open' } } });
  });
  it('omits the key when no annotations are given', () => {
    const def = defineNamespace('ann2', { T: { fields: { name: field.string() } } });
    expect('annotations' in def).toBe(false);
  });
  it('rejects a value that does not survive JSON', () => {
    expect(() =>
      defineNamespace(
        'ann3',
        { T: { fields: { name: field.string() } } },
        {
          annotations: { nl: { fn: () => 1 } as unknown as Record<string, unknown> }
        }
      )
    ).toThrow(/annotations.*JSON/);
    expect(() =>
      defineNamespace(
        'ann4',
        { T: { fields: { name: field.string() } } },
        {
          annotations: { nl: { when: new Date(0) } }
        }
      )
    ).toThrow(/annotations.*JSON/);
  });
});
