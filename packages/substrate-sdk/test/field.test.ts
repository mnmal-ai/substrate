import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { PackEnvelope, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installAutoCrud } from '../src/autocrud/index.js';
import { field } from '../src/field.js';

describe('field DSL', () => {
  it('field.string defaults to indexed: true and omits nullable', () => {
    expect(field.string()).toEqual({ kind: 'scalar', type: 'string', indexed: true });
  });

  it('field.number / boolean / date share the scalar shape', () => {
    expect(field.number()).toEqual({ kind: 'scalar', type: 'number', indexed: true });
    expect(field.boolean()).toEqual({ kind: 'scalar', type: 'boolean', indexed: true });
    expect(field.date()).toEqual({ kind: 'scalar', type: 'date', indexed: true });
  });

  it('indexed override flows through on every scalar builder', () => {
    expect(field.string({ indexed: false }).indexed).toBe(false);
    expect(field.number({ indexed: false }).indexed).toBe(false);
    expect(field.boolean({ indexed: false }).indexed).toBe(false);
    expect(field.date({ indexed: false }).indexed).toBe(false);
  });

  it('nullable override flows through and is only present when set', () => {
    expect('nullable' in field.string()).toBe(false);
    expect(field.string({ nullable: true }).nullable).toBe(true);
    expect(field.string({ nullable: false }).nullable).toBe(false);
  });

  it('field.crossRef defaults to indexed: true and onDelete: set_null', () => {
    expect(field.crossRef('users', 'User')).toEqual({
      kind: 'crossRef',
      ns: 'users',
      type: 'User',
      onDelete: 'set_null',
      indexed: true
    });
  });

  it('field.crossRef accepts onDelete + indexed + nullable overrides', () => {
    const ref = field.crossRef('users', 'User', {
      onDelete: 'cascade',
      indexed: false,
      nullable: true
    });
    expect(ref).toEqual({
      kind: 'crossRef',
      ns: 'users',
      type: 'User',
      onDelete: 'cascade',
      indexed: false,
      nullable: true
    });
  });

  it('field.crossRef threads flat spread + expandCrossType', () => {
    const ref = field.crossRef('claude', 'Concept', {
      spread: true,
      expandCrossType: true
    });
    expect(ref.spread).toBe(true);
    expect(ref.expandCrossType).toBe(true);
  });

  it('field.crossRef throws when expandCrossType is set without spread', () => {
    expect(() => field.crossRef('claude', 'Concept', { expandCrossType: true })).toThrow(
      /expandCrossType requires spread/
    );
    // spread without expandCrossType stays valid — expandCrossType omitted.
    const ref = field.crossRef('claude', 'Concept', { spread: true });
    expect(ref.spread).toBe(true);
    expect(ref.expandCrossType).toBeUndefined();
  });
});

describe('field.crossRef onMissing', () => {
  it('omits onMissing by default (absence == enforce-where-enforceable)', () => {
    const def = field.crossRef('labs', 'Trace');
    expect(def.onMissing).toBeUndefined();
  });

  it("passes through onMissing: 'reject'", () => {
    const def = field.crossRef('labs', 'Trace', { onMissing: 'reject' });
    expect(def.onMissing).toBe('reject');
  });

  it("passes through onMissing: 'allow' explicitly", () => {
    const def = field.crossRef('labs', 'Trace', { onMissing: 'allow' });
    expect(def.onMissing).toBe('allow');
  });

  it('field.struct passes fields through untouched and omits nullable by default', () => {
    const struct = field.struct({ a: field.string(), b: field.number() });
    expect(struct.kind).toBe('struct');
    expect(struct.fields.a).toEqual(field.string());
    expect(struct.fields.b).toEqual(field.number());
    expect('nullable' in struct).toBe(false);
  });

  it('field.struct composes nested crossRef + list + struct', () => {
    const nested = field.struct(
      {
        ref: field.crossRef('users', 'User'),
        tags: field.list(field.string())
      },
      { nullable: true }
    );
    expect(nested.fields.ref).toMatchObject({ kind: 'crossRef', ns: 'users' });
    expect(nested.fields.tags).toMatchObject({ kind: 'list', of: { kind: 'scalar' } });
    expect(nested.nullable).toBe(true);
  });

  it('field.list wraps an inner FieldDef', () => {
    const list = field.list(field.string());
    expect(list).toEqual({ kind: 'list', of: { kind: 'scalar', type: 'string', indexed: true } });
  });

  it('field.json defaults to indexed: false', () => {
    expect(field.json()).toEqual({ kind: 'scalar', type: 'json', indexed: false });
  });

  it('field.json({ indexed: true }) opts in to a derived GIN for path filters', () => {
    expect(field.json({ indexed: true })).toEqual({ kind: 'scalar', type: 'json', indexed: true });
  });

  it('field.json accepts nullable', () => {
    expect(field.json({ nullable: true })).toEqual({
      kind: 'scalar',
      type: 'json',
      indexed: false,
      nullable: true
    });
  });

  it('field.enum produces a string scalar carrying the vocabulary', () => {
    expect(field.enum(['low', 'medium', 'high'])).toEqual({
      kind: 'scalar',
      type: 'string',
      indexed: true,
      enum: ['low', 'medium', 'high']
    });
  });

  it('field.enum threads scalar options through (nullable, indexed)', () => {
    expect(field.enum(['a', 'b'], { nullable: true, indexed: false })).toEqual({
      kind: 'scalar',
      type: 'string',
      indexed: false,
      nullable: true,
      enum: ['a', 'b']
    });
  });

  it('round-trips through installAutoCrud + engine.mutate (field-DSL output is the schema)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: field.string(),
        title: field.string(),
        priority: field.number({ indexed: false }),
        done: field.boolean()
      }
    });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['default', { registry }]]),
      datasets,
      edges
    });

    const ctx: Partial<RequestContext> = {
      namespace: 'default',
      // A write says who made it.
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } }
    };
    const env: PackEnvelope = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: '1', title: 'hi', priority: 1, done: false },
          fields: { id: true, title: true }
        }
      },
      ctx
    });
    expect(env.errors).toBeUndefined();
    const created = env.data['default/createTodo'] as { id: string; title: string };
    expect(created.title).toBe('hi');
  });
});

describe('field.date serverSet flag', () => {
  it('default: serverSet undefined', () => {
    const f = field.date();
    expect(f.kind).toBe('scalar');
    expect(f.type).toBe('date');
    expect(f.serverSet).toBeUndefined();
  });

  it('accepts serverSet=create', () => {
    const f = field.date({ serverSet: 'create' });
    expect(f.serverSet).toBe('create');
  });

  it('accepts serverSet=update', () => {
    const f = field.date({ serverSet: 'update' });
    expect(f.serverSet).toBe('update');
  });

  it('accepts serverSet=both', () => {
    const f = field.date({ serverSet: 'both' });
    expect(f.serverSet).toBe('both');
  });

  it('preserves nullable + serverSet together', () => {
    const f = field.date({ nullable: true, serverSet: 'create' });
    expect(f.nullable).toBe(true);
    expect(f.serverSet).toBe('create');
  });
});
