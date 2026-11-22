import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { ActionDecl, ActionLayer, FieldDef } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const fields: Record<string, FieldDef> = {
  title: { kind: 'scalar', type: 'string' },
  status: { kind: 'scalar', type: 'string', enum: ['open', 'closed'] }
};

class FakeLayer implements ActionLayer {
  readonly proposeKey = '_system_proposals/propose_action';
  words: Record<string, Record<string, ActionDecl>> = {};
  published(ns: string): Record<string, Record<string, ActionDecl>> {
    return ns === 'shop' ? this.words : {};
  }
  pendingFor(): Record<string, never> {
    return {};
  }
  used(): void {}
}

describe('action layer seam', () => {
  let engine: Engine;
  let layer: FakeLayer;

  beforeEach(() => {
    const registry = new Registry();
    registry.register('Ticket', {
      kind: 'type',
      resolver: async () => [],
      fields,
      actions: { close: { set: { status: 'closed' } } }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('shop', new MemoryDataset({ namespace: 'shop' }));
    engine = new Engine({
      namespaces: new Map([['shop', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date('2026-05-03T00:00:00Z') })
    });
    layer = new FakeLayer();
  });

  it('publishes a coined word on its type, marked coined', () => {
    layer.words = { Ticket: { reopen: { set: { status: 'open' } } } };
    engine.setActionLayer(layer);
    engine.invalidateSchemaCaches('shop');
    expect(engine.schemaFor('shop').types.Ticket?.actions?.reopen).toMatchObject({
      kind: 'update',
      coined: true,
      fixed: ['status']
    });
  });

  it('moves schemaVersion when the published set changes', () => {
    engine.setActionLayer(layer);
    const before = engine.schemaFor('shop').schemaVersion;
    layer.words = { Ticket: { reopen: { set: { status: 'open' } } } };
    engine.invalidateSchemaCaches('shop');
    expect(engine.schemaFor('shop').schemaVersion).not.toBe(before);
  });

  it('lets a declared action win over a coined word of the same name', () => {
    layer.words = { Ticket: { close: { set: { status: 'open' } } } };
    engine.setActionLayer(layer);
    engine.invalidateSchemaCaches('shop');
    const close = engine.schemaFor('shop').types.Ticket?.actions?.close;
    expect(close?.set).toEqual({ status: 'closed' });
    expect(close?.coined).toBeUndefined();
  });

  it('skips a coined word whose type is absent', () => {
    layer.words = { Ghost: { x: { set: { status: 'open' } } } };
    engine.setActionLayer(layer);
    engine.invalidateSchemaCaches('shop');
    expect(engine.schemaFor('shop').types.Ghost).toBeUndefined();
  });

  it('refuses a second action layer', () => {
    engine.setActionLayer(layer);
    expect(() => engine.setActionLayer(layer)).toThrow(/already/);
  });
});
