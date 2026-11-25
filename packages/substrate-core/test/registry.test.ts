import type { Policy, RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  clearExtensionOperators,
  DuplicateRegistration,
  Registry,
  type Resolver,
  registerExtensionOperator
} from '../src/index.js';

const noopResolver: Resolver = async () => [];
const allowPolicy: Policy = () => ({ allow: true });

class Foo {}
class Bar {}

describe('Registry', () => {
  it('register + get by class constructor', () => {
    const r = new Registry();
    r.register(Foo, { resolver: noopResolver });
    const entry = r.get('Foo');
    expect(entry).toBeDefined();
    expect(entry?.resolver).toBe(noopResolver);
  });

  it('register + get by string name', () => {
    const r = new Registry();
    r.register('Foo', { resolver: noopResolver });
    expect(r.get('Foo')).toBeDefined();
  });

  it('defaults policy to allowAll when absent', async () => {
    const r = new Registry();
    r.register(Foo, { resolver: noopResolver });
    const entry = r.get('Foo');
    const ctx = {} as RequestContext;
    const args = {} as ResolverArgs;
    expect(entry?.policy(ctx, args)).toEqual({ allow: true });
  });

  it('preserves explicit policy', () => {
    const r = new Registry();
    r.register(Foo, { resolver: noopResolver, policy: allowPolicy });
    const entry = r.get('Foo');
    expect(entry?.policy).toBe(allowPolicy);
  });

  it('has() reports membership', () => {
    const r = new Registry();
    expect(r.has('Foo')).toBe(false);
    r.register(Foo, { resolver: noopResolver });
    expect(r.has('Foo')).toBe(true);
  });

  it('get() returns undefined for unknown', () => {
    const r = new Registry();
    expect(r.get('Nope')).toBeUndefined();
  });

  it('all() lists registered entries', () => {
    const r = new Registry();
    r.register(Foo, { resolver: noopResolver });
    r.register(Bar, { resolver: noopResolver });
    const names = [...r.all()].map(([name]) => name).sort();
    expect(names).toEqual(['Bar', 'Foo']);
  });

  it('throws DuplicateRegistration on re-register', () => {
    const r = new Registry();
    r.register(Foo, { resolver: noopResolver });
    expect(() => r.register(Foo, { resolver: noopResolver })).toThrow(DuplicateRegistration);
  });

  it('distinguishes string + class with the same name via .name', () => {
    const r = new Registry();
    r.register('Foo', { resolver: noopResolver });
    expect(() => r.register(Foo, { resolver: noopResolver })).toThrow(DuplicateRegistration);
  });

  it('resolver receives ctx + args (smoke)', async () => {
    const rows: Row[] = [{ id: 1 }];
    const resolver: Resolver = async (_ctx, _args) => rows;
    const r = new Registry();
    r.register(Foo, { resolver });
    const entry = r.get('Foo');
    const ctx = {} as RequestContext;
    const out = await entry?.resolver(ctx, {} as ResolverArgs);
    expect(out).toBe(rows);
  });
});

describe('Registry replace and the batch resolver', () => {
  const batch = async (): Promise<Array<null>> => [];

  it('drops a batch carried over beside a new resolver', () => {
    const registry = new Registry();
    registry.register('deleteTodo', { resolver: noopResolver, batch, kind: 'mutation' });
    const entry = registry.get('deleteTodo');
    if (entry === undefined) throw new Error('deleteTodo was not registered');
    const guarded: Resolver = async (ctx, args) => entry.resolver(ctx, args);
    registry.replace('deleteTodo', { ...entry, resolver: guarded });
    expect(registry.get('deleteTodo')?.resolver).toBe(guarded);
    expect(registry.get('deleteTodo')?.batch).toBeUndefined();
  });

  it('keeps a batch replaced with the resolver, and one beside an unchanged resolver', () => {
    const registry = new Registry();
    registry.register('deleteTodo', { resolver: noopResolver, batch, kind: 'mutation' });
    const entry = registry.get('deleteTodo');
    if (entry === undefined) throw new Error('deleteTodo was not registered');
    registry.replace('deleteTodo', { ...entry, verb: 'delete' });
    expect(registry.get('deleteTodo')?.batch).toBe(batch);
    const ownBatch = async (): Promise<Array<null>> => [];
    registry.replace('deleteTodo', { ...entry, resolver: async () => [], batch: ownBatch });
    expect(registry.get('deleteTodo')?.batch).toBe(ownBatch);
  });
});

describe('Registry verb stamping', () => {
  it('stores and reads back verb on register() and replace(); absent when omitted', () => {
    const registry = new Registry();
    const resolver = async (): Promise<null> => null;
    registry.register('deleteTodo', { resolver, kind: 'mutation', verb: 'delete' });
    registry.register('customNuke', { resolver, kind: 'mutation' });
    expect(registry.get('deleteTodo')?.verb).toBe('delete');
    expect(registry.get('customNuke')?.verb).toBeUndefined();
    registry.replace('deleteTodo', { resolver, kind: 'mutation', verb: 'update' });
    expect(registry.get('deleteTodo')?.verb).toBe('update');
    registry.replace('deleteTodo', { resolver, kind: 'mutation' });
    expect(registry.get('deleteTodo')?.verb).toBeUndefined();
  });
});

it('refuses a declared field named like a registered filter operator', () => {
  registerExtensionOperator('status', {
    validate: (value) => ({ ok: true, value }),
    execute: async () => ({ hits: [] })
  });
  try {
    const r = new Registry();
    const fields = { status: { kind: 'scalar', type: 'string' } } as const;
    expect(() => r.register('Todo', { resolver: noopResolver, fields })).toThrow(/filter operator/);
    r.register('Todo', { resolver: noopResolver });
    expect(() => r.replace('Todo', { resolver: noopResolver, fields })).toThrow(/filter operator/);
  } finally {
    clearExtensionOperators();
  }
});
