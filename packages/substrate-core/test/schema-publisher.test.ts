import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, FieldDef, NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  loadPlugins,
  MemoryEdgesStore,
  publishSchema,
  Registry,
  type Resolver
} from '../src/index.js';

const noop: Resolver = async () => [];

const stringField: FieldDef = { kind: 'scalar', type: 'string' };
const numberField: FieldDef = { kind: 'scalar', type: 'number' };
const boolField: FieldDef = { kind: 'scalar', type: 'boolean' };

describe('publishSchema', () => {
  it('emits an entry per registered type', () => {
    const r = new Registry();
    r.register('Todo', {
      resolver: noop,
      fields: { id: stringField, title: stringField, done: boolField }
    });
    r.register('Tag', { resolver: noop, fields: { id: stringField } });

    const schema = publishSchema(r);
    expect(Object.keys(schema.types).sort()).toEqual(['Tag', 'Todo']);
    expect(schema.types.Todo?.fields.title).toEqual(stringField);
    expect(schema.types.Todo?.fields.done).toEqual(boolField);
    expect(schema.mutations).toEqual({});
  });

  it('routes entries by kind (type vs mutation)', () => {
    const r = new Registry();
    r.register('Todo', { resolver: noop, kind: 'type', fields: { id: stringField } });
    r.register('createTodo', {
      resolver: noop,
      kind: 'mutation',
      params: { id: stringField, title: stringField },
      returns: {
        kind: 'struct',
        fields: { id: stringField, title: stringField }
      }
    });
    r.register('listTodo', { resolver: noop, kind: 'mutation' });

    const schema = publishSchema(r);
    expect(Object.keys(schema.types)).toEqual(['Todo']);
    expect(Object.keys(schema.mutations).sort()).toEqual(['createTodo', 'listTodo']);
  });

  it('defaults kind to type when not supplied', () => {
    const r = new Registry();
    r.register('Todo', { resolver: noop, fields: { id: stringField } });
    // `createTodo` without a `kind` lands in types — name-case is not a
    // discriminator. Explicit `kind: 'mutation'` is required.
    r.register('createTodo', { resolver: noop, fields: { id: stringField } });

    const schema = publishSchema(r);
    expect(Object.keys(schema.types).sort()).toEqual(['Todo', 'createTodo']);
    expect(schema.mutations).toEqual({});
  });

  it('schemaVersion is a 12-char hex string', () => {
    const r = new Registry();
    r.register('Todo', { resolver: noop, fields: { id: stringField } });
    const schema = publishSchema(r);
    expect(schema.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic — identical registries produce identical versions', () => {
    const r1 = new Registry();
    r1.register('Todo', {
      resolver: noop,
      fields: { id: stringField, title: stringField, done: boolField }
    });
    r1.register('Tag', { resolver: noop, fields: { id: stringField, label: stringField } });

    const r2 = new Registry();
    // Register in opposite order — canonicalization should normalise.
    r2.register('Tag', { resolver: noop, fields: { label: stringField, id: stringField } });
    r2.register('Todo', {
      resolver: noop,
      fields: { done: boolField, title: stringField, id: stringField }
    });

    expect(publishSchema(r1).schemaVersion).toBe(publishSchema(r2).schemaVersion);
  });

  it('changes version when a field is added to a type', () => {
    const r1 = new Registry();
    r1.register('Todo', { resolver: noop, fields: { id: stringField } });
    const r2 = new Registry();
    r2.register('Todo', { resolver: noop, fields: { id: stringField, title: stringField } });
    expect(publishSchema(r1).schemaVersion).not.toBe(publishSchema(r2).schemaVersion);
  });

  it('changes version when a new type is added', () => {
    const r1 = new Registry();
    r1.register('Todo', { resolver: noop, fields: { id: stringField } });
    const before = publishSchema(r1).schemaVersion;

    const r2 = new Registry();
    r2.register('Todo', { resolver: noop, fields: { id: stringField } });
    r2.register('Tag', { resolver: noop, fields: { id: stringField } });
    const after = publishSchema(r2).schemaVersion;

    expect(before).not.toBe(after);
  });

  it('changes version when a field type changes', () => {
    const r1 = new Registry();
    r1.register('Todo', { resolver: noop, fields: { id: stringField } });
    const r2 = new Registry();
    r2.register('Todo', { resolver: noop, fields: { id: numberField } });
    expect(publishSchema(r1).schemaVersion).not.toBe(publishSchema(r2).schemaVersion);
  });

  it('emits empty fields for types registered without a field map', () => {
    const r = new Registry();
    r.register('Todo', { resolver: noop });
    const schema = publishSchema(r);
    expect(schema.types.Todo).toEqual({ fields: {} });
  });

  it('emits params + returns for mutation entries with explicit metadata', () => {
    const r = new Registry();
    const todoFields: Record<string, FieldDef> = { id: stringField, title: stringField };
    r.register('createTodo', {
      resolver: noop,
      kind: 'mutation',
      params: todoFields,
      returns: { kind: 'struct', fields: todoFields }
    });

    const schema = publishSchema(r);
    const mut = schema.mutations.createTodo;
    expect(mut).toBeDefined();
    expect(mut?.params).toEqual(todoFields);
    expect(mut?.returns).toEqual({ kind: 'struct', fields: todoFields });
  });

  it('falls back to an unknown-returns sentinel when a mutation omits returns', () => {
    const r = new Registry();
    r.register('weirdMutation', { resolver: noop, kind: 'mutation' });
    const schema = publishSchema(r);
    const mut = schema.mutations.weirdMutation;
    expect(mut).toBeDefined();
    expect(mut?.params).toEqual({});
    expect(mut?.returns).toEqual({ kind: 'scalar', type: 'string', nullable: true });
  });

  it('schemaVersion shifts when mutation returns shape changes', () => {
    const r1 = new Registry();
    r1.register('createTodo', {
      resolver: noop,
      kind: 'mutation',
      params: { id: stringField },
      returns: { kind: 'struct', fields: { id: stringField } }
    });
    const r2 = new Registry();
    r2.register('createTodo', {
      resolver: noop,
      kind: 'mutation',
      params: { id: stringField },
      returns: { kind: 'struct', fields: { id: stringField, title: stringField } }
    });
    expect(publishSchema(r1).schemaVersion).not.toBe(publishSchema(r2).schemaVersion);
  });

  it('passes a field enum vocabulary through to the published schema', () => {
    const r = new Registry();
    r.register('Widget', {
      resolver: noop,
      fields: {
        id: stringField,
        size: { kind: 'scalar', type: 'string', enum: ['s', 'm', 'l'] }
      }
    });
    const schema = publishSchema(r);
    expect(schema.types.Widget?.fields.size).toMatchObject({
      kind: 'scalar',
      type: 'string',
      enum: ['s', 'm', 'l']
    });
  });
});

describe('namespace annotations', () => {
  async function engineWith(annotations?: Record<string, unknown>): Promise<Engine> {
    const nsDef: NamespaceDefinition = {
      namespace: 'a',
      ...(annotations !== undefined ? { annotations } : {}),
      install: ({ registry }) => {
        registry.register('T', { resolver: noop, fields: { id: stringField, name: stringField } });
      }
    };
    const dataset = new MemoryDataset({ namespace: 'a' });
    const loaded = await loadPlugins({
      plugins: [{ name: 'p', contractVersion: '*', namespaces: [nsDef] }],
      edges: new MemoryEdgesStore({ now: () => new Date() }),
      datasetFor: (ns): Dataset | undefined => (ns === 'a' ? dataset : undefined)
    });
    return new Engine({
      namespaces: loaded.namespaces,
      datasets: { get: (ns: string) => loaded.datasets.get(ns) },
      edges: undefined
    } as unknown as ConstructorParameters<typeof Engine>[0]);
  }

  it('annotations reach schemaFor and do not move schemaVersion', async () => {
    const plain = await engineWith();
    const annotated = await engineWith({ nl: { x: 1 } });
    expect(annotated.schemaFor('a').annotations).toEqual({ nl: { x: 1 } });
    expect(plain.schemaFor('a').annotations).toBeUndefined();
    expect(annotated.schemaFor('a').schemaVersion).toBe(plain.schemaFor('a').schemaVersion);
    expect(annotated.federatedSchema().a?.annotations).toEqual({ nl: { x: 1 } });
  });
});
