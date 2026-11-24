import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Identity } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function build() {
  const registry = new Registry();
  const ran: string[] = [];
  const entry = (name: string, extra: Record<string, unknown> = {}) =>
    registry.register(name, {
      fields: { name: { kind: 'scalar', type: 'string' } },
      resolver: async () => {
        ran.push(name);
        return [];
      },
      ...extra
    });
  entry('Note');
  entry('getNote', { kind: 'mutation', verb: 'get' });
  entry('createNote', { kind: 'mutation', verb: 'create' });
  entry('deleteNote', { kind: 'mutation', verb: 'delete' });
  entry('archiveNotes', { kind: 'mutation' });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('ns', new MemoryDataset({ namespace: 'ns' }));
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['ns', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') })
  });
  return { engine, ran };
}

const ctxOf = (identity: Identity | null) => ({ identity, now: new Date(), headers: {}, meta: {} });
const reader: Identity = { id: 'reader', kind: 'agent', grants: { ns: ['read'] } };
const writer: Identity = { id: 'writer', kind: 'agent', grants: { ns: ['mutate'] } };
const frame = (key: string) => ({ [key]: { params: {}, fields: { id: true } } });

describe('query route refuses writing entries', () => {
  for (const key of ['ns/createNote', 'ns/deleteNote', 'ns/archiveNotes']) {
    it(`refuses ${key} for a read-only key and for a caller with no identity`, async () => {
      for (const identity of [reader, null]) {
        const { engine, ran } = build();
        const res = await engine.query({ frame: frame(key), ctx: ctxOf(identity) });
        expect(res.errors?.map((e) => e.code)).toEqual(['mutation_on_query']);
        expect(res.data).not.toHaveProperty(key);
        expect(ran).toEqual([]);
      }
    });
  }

  it('still runs a type read and get<T> on query', async () => {
    const { engine, ran } = build();
    const res = await engine.query({
      frame: { ...frame('ns/Note'), ...frame('ns/getNote') },
      ctx: ctxOf(reader)
    });
    expect(res.errors ?? []).toEqual([]);
    expect(ran).toEqual(['Note', 'getNote']);
  });
});

describe('mutate route requires read for reading entries', () => {
  for (const key of ['ns/Note', 'ns/getNote']) {
    it(`refuses ${key} for a mutate-only key`, async () => {
      const { engine, ran } = build();
      const res = await engine.mutate({ frame: frame(key), ctx: ctxOf(writer) });
      expect(res.errors?.map((e) => e.code)).toEqual(['unauthorized_capability']);
      expect(ran).toEqual([]);
    });
  }

  it('still runs a write for a mutate-only key', async () => {
    const { engine, ran } = build();
    const res = await engine.mutate({ frame: frame('ns/createNote'), ctx: ctxOf(writer) });
    expect(res.errors ?? []).toEqual([]);
    expect(ran).toEqual(['createNote']);
  });
});
