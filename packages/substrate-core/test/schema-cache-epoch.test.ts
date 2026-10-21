/**
 * The published schema (and `federatedSchemaVersion`) must reflect types
 * registered at RUNTIME (`propose_type` / `propose_field`) with no explicit
 * invalidation call.
 *
 * A stale schema does not break dispatch — the entry is in the registry, so
 * using the new type works — only DISCOVERY is wrong, so these tests assert on
 * the schema itself rather than on queries.
 *
 * The cache is invalidated from the DATA: `Registry.epoch` counts mutations,
 * and the cache holds the epoch it was built at.
 */

import {
  RegistryBase,
  type Registry as RegistryContract,
  type RegistryEntry,
  type RegistryEntryInput
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { Registry } from '../src/registry.js';

const noopResolver = async (): Promise<null> => null;

function makeEngine(): { engine: Engine; registry: Registry } {
  const registry = new Registry();
  registry.register('Alpha', { resolver: noopResolver, kind: 'type', fields: {} });
  const engine = new Engine({
    namespaces: new Map([['ns', { registry, plugin: 'test' }]]),
    datasets: { get: () => undefined },
    edges: undefined
  } as unknown as ConstructorParameters<typeof Engine>[0]);
  return { engine, registry };
}

describe('published schema tracks the registry without being told', () => {
  it('a type registered after the schema was first read is visible', () => {
    const { engine, registry } = makeEngine();

    // Populate the cache, exactly as a cold-start `schema` call would.
    expect(Object.keys(engine.schemaFor('ns').types)).toEqual(['Alpha']);

    // Runtime registration — the propose_type shape — with NO invalidation call.
    registry.register('Beta', { resolver: noopResolver, kind: 'type', fields: {} });

    expect(Object.keys(engine.schemaFor('ns').types).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('a replaced entry re-publishes its fields', () => {
    const { engine, registry } = makeEngine();
    expect(engine.schemaFor('ns').types.Alpha?.fields).toEqual({});

    // The propose_field shape: installAutoCrud funnelled through registry.replace.
    registry.replace('Alpha', {
      resolver: noopResolver,
      kind: 'type',
      fields: { owner: { kind: 'scalar', type: 'string', indexed: true } }
    });

    expect(Object.keys(engine.schemaFor('ns').types.Alpha?.fields ?? {})).toEqual(['owner']);
  });

  it('federatedSchema and federatedSchemaVersion follow too', () => {
    const { engine, registry } = makeEngine();
    const versionBefore = engine.federatedSchemaVersion();
    expect(Object.keys(engine.federatedSchema().ns?.types ?? {})).toEqual(['Alpha']);

    registry.register('Beta', { resolver: noopResolver, kind: 'type', fields: {} });

    expect(Object.keys(engine.federatedSchema().ns?.types ?? {}).sort()).toEqual(['Alpha', 'Beta']);
    // The drift signal must actually move after a runtime registration.
    expect(engine.federatedSchemaVersion()).not.toBe(versionBefore);
  });

  it('does not rebuild when the registry has not moved', () => {
    const { engine } = makeEngine();
    // Identity, not equality: an unchanged epoch must return the cached object,
    // or the cache has stopped being a cache.
    expect(engine.schemaFor('ns')).toBe(engine.schemaFor('ns'));
    expect(engine.federatedSchemaVersion()).toBe(engine.federatedSchemaVersion());
  });
});

describe('epoch is supplied by construction, not by discipline', () => {
  /**
   * The point of `RegistryBase`: a subclass supplies STORAGE and never
   * implements `register` / `replace`, so it cannot forget to advance the
   * counter. An optional field each implementer maintains by hand would be a
   * duty that can be forgotten.
   */
  it('a subclass that never touches epoch still reports one', () => {
    class Minimal extends RegistryBase {
      readonly #entries = new Map<string, RegistryEntry>();
      protected performRegister(key: string, input: RegistryEntryInput): void {
        this.#entries.set(key, input as RegistryEntry);
      }
      protected performReplace(key: string, input: RegistryEntryInput): void {
        this.#entries.set(key, input as RegistryEntry);
      }
      get(key: string): RegistryEntry | undefined {
        return this.#entries.get(key);
      }
      has(key: string): boolean {
        return this.#entries.has(key);
      }
      all(): IterableIterator<[string, RegistryEntry]> {
        return this.#entries.entries();
      }
    }
    const r = new Minimal();
    expect(r.epoch).toBe(0);
    r.register('A', { resolver: noopResolver, kind: 'type', fields: {} });
    expect(r.epoch).toBe(1);
    r.replace('A', { resolver: noopResolver, kind: 'type', fields: {} });
    expect(r.epoch).toBe(2);
  });

  it('a rejected registration does not advance the epoch', () => {
    const r = new Registry();
    r.register('A', { resolver: noopResolver, kind: 'type', fields: {} });
    const before = r.epoch;
    expect(() => r.register('A', { resolver: noopResolver, kind: 'type', fields: {} })).toThrow();
    expect(r.epoch).toBe(before);
  });

  it('a registry with no epoch is rebuilt every read, never cached stale', () => {
    // A hand-rolled Registry-shaped object — the decorator case, which cannot
    // inherit from RegistryBase. Omitting `epoch` must degrade to "rebuild",
    // not to "cache forever": the second is silent staleness, the first is only
    // ever a performance cost.
    const entries = new Map<string, RegistryEntry>();
    const bare: RegistryContract = {
      register: (k, i) => void entries.set(String(k), i as RegistryEntry),
      replace: (k, i) => void entries.set(String(k), i as RegistryEntry),
      get: (k) => entries.get(String(k)),
      has: (k) => entries.has(String(k)),
      all: () => entries.entries()
    };
    bare.register('Alpha', { resolver: noopResolver, kind: 'type', fields: {} });

    const engine = new Engine({
      namespaces: new Map([['ns', { registry: bare, plugin: 'test' }]]),
      datasets: { get: () => undefined },
      edges: undefined
    } as unknown as ConstructorParameters<typeof Engine>[0]);

    expect(Object.keys(engine.schemaFor('ns').types)).toEqual(['Alpha']);
    bare.register('Beta', { resolver: noopResolver, kind: 'type', fields: {} });
    expect(Object.keys(engine.schemaFor('ns').types).sort()).toEqual(['Alpha', 'Beta']);
  });
});
