import type { Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { decodeStreamChunk, encodeStreamChunk } from '../src/stream-chunk.js';

function schemaWith(types: Schema['types']): Schema {
  return { schemaVersion: 'aa00bb11cc22', types, mutations: {} };
}

describe('PackStreamChunk codec (§7.4)', () => {
  const schema = schemaWith({
    Todo: {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        done: { kind: 'scalar', type: 'boolean' }
      }
    }
  });

  it('round-trips a chunk with positional data via FieldInput', () => {
    const bytes = encodeStreamChunk({
      schemaVersion: schema.schemaVersion,
      streamId: 'stream-1',
      sequence: 0,
      row: { id: 't1', title: 'alpha', done: false },
      fields: { id: true, title: true, done: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(Buffer.isBuffer(bytes)).toBe(true);

    const chunk = decodeStreamChunk<{ id: string; title: string; done: boolean }>(bytes, {
      fields: { id: true, title: true, done: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(chunk.schemaVersion).toBe(schema.schemaVersion);
    expect(chunk.streamId).toBe('stream-1');
    expect(chunk.sequence).toBe(0);
    expect(chunk.shape).toBe('single');
    expect(chunk.data).toEqual({ id: 't1', title: 'alpha', done: false });
    expect(chunk.final).toBeUndefined();
    expect(chunk._meta).toBeUndefined();
  });

  it('round-trips `final: true`', () => {
    const bytes = encodeStreamChunk({
      schemaVersion: schema.schemaVersion,
      streamId: 's',
      sequence: 4,
      row: { id: 'last', title: 'z', done: true },
      fields: { id: true, title: true, done: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default',
      final: true
    });
    const chunk = decodeStreamChunk(bytes, {
      fields: { id: true, title: true, done: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(chunk.final).toBe(true);
    expect(chunk.sequence).toBe(4);
  });

  it('round-trips `_meta`', () => {
    const bytes = encodeStreamChunk({
      schemaVersion: schema.schemaVersion,
      streamId: 's',
      sequence: 0,
      row: { id: 'x', title: 'y', done: false },
      fields: { id: true, title: true, done: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default',
      meta: { latencyMs: 42, warnings: ['deprecated-field'] }
    });
    const chunk = decodeStreamChunk(bytes, {
      fields: { id: true, title: true, done: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(chunk._meta).toEqual({ latencyMs: 42, warnings: ['deprecated-field'] });
  });

  it('schemaVersion round-trips verbatim', () => {
    const v = 'deadbeef1234';
    const bytes = encodeStreamChunk({
      schemaVersion: v,
      streamId: 's',
      sequence: 0,
      row: { id: 'x', title: 'y', done: false },
      fields: { id: true, title: true, done: true },
      schema: { ...schema, schemaVersion: v },
      typeName: 'Todo',
      currentNs: 'default'
    });
    const chunk = decodeStreamChunk(bytes, {
      fields: { id: true, title: true, done: true },
      schema: { ...schema, schemaVersion: v },
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(chunk.schemaVersion).toBe(v);
  });

  it('sequence monotonic — authored chunks round-trip in order', () => {
    const rows = [
      { id: 't1', title: 'a', done: false },
      { id: 't2', title: 'b', done: true },
      { id: 't3', title: 'c', done: false }
    ];
    const decoded = rows.map((row, idx) => {
      const bytes = encodeStreamChunk({
        schemaVersion: schema.schemaVersion,
        streamId: 'seq',
        sequence: idx,
        row,
        fields: { id: true, title: true, done: true },
        schema,
        typeName: 'Todo',
        currentNs: 'default'
      });
      return decodeStreamChunk<{ id: string }>(bytes, {
        fields: { id: true, title: true, done: true },
        schema,
        typeName: 'Todo',
        currentNs: 'default'
      });
    });
    expect(decoded.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(decoded.map((c) => c.data.id)).toEqual(['t1', 't2', 't3']);
  });

  it('subset FieldInput drops unselected fields from the decoded row', () => {
    const bytes = encodeStreamChunk({
      schemaVersion: schema.schemaVersion,
      streamId: 's',
      sequence: 0,
      row: { id: 'pick', title: 'keep', done: true },
      // Only project id + title. `done` should never make it to the wire.
      fields: { id: true, title: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default'
    });
    const chunk = decodeStreamChunk<{ id: string; title: string; done?: boolean }>(bytes, {
      fields: { id: true, title: true },
      schema,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(chunk.data).toEqual({ id: 'pick', title: 'keep' });
    expect(chunk.data.done).toBeUndefined();
  });
});
