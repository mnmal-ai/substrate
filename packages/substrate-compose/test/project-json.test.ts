/**
 * JSON-path field projection.
 *
 * JSON projection mirrors pack semantics (only selected slots are emitted),
 * and `fields: undefined` (or missing) opts out so callers relying on
 * full-row JSON keep working.
 */

import type { FieldInput, PackEnvelope, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/routes/helpers.js';
import { projectEnvelope, projectValue, projectWsFrame } from '../src/routes/project-json.js';

function envelope(data: Record<string, unknown>): PackEnvelope {
  return {
    schemaVersion: 'sv',
    data,
    shapes: {}
  };
}

describe('projectValue', () => {
  it('passes scalars through when selection is true', () => {
    expect(projectValue('hi', true)).toBe('hi');
    expect(projectValue(42, true)).toBe(42);
    expect(projectValue(null, true)).toBeNull();
  });

  it('keeps only selected keys on an object', () => {
    const row = { id: '1', title: 'x', body: 'y', _metadata: { createdAt: 'now' } };
    expect(projectValue(row, { id: true, title: true })).toEqual({ id: '1', title: 'x' });
  });

  it('omits selected keys absent on the source', () => {
    expect(projectValue({ id: '1' }, { id: true, missing: true })).toEqual({ id: '1' });
  });

  it('walks nested struct projections', () => {
    const row = { _metadata: { createdAt: 'a', updatedAt: 'b', createdBy: { kind: 'agent' } } };
    expect(projectValue(row, { _metadata: { createdAt: true } })).toEqual({
      _metadata: { createdAt: 'a' }
    });
  });

  it('walks list projections element-wise', () => {
    const rows = [
      { id: '1', name: 'a', drop: 'x' },
      { id: '2', name: 'b', drop: 'y' }
    ];
    expect(projectValue(rows, { id: true, name: true })).toEqual([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' }
    ]);
  });

  it('passes null/undefined through any selection unchanged', () => {
    expect(projectValue(null, { id: true })).toBeNull();
    expect(projectValue(undefined, { id: true })).toBeUndefined();
  });

  it('passes through nested whole-struct via leaf-true', () => {
    const row = { _metadata: { createdAt: 'a', updatedAt: 'b' } };
    expect(projectValue(row, { _metadata: true })).toEqual({
      _metadata: { createdAt: 'a', updatedAt: 'b' }
    });
  });
});

describe('projectEnvelope', () => {
  it('projects each frame entry against its fields', () => {
    const env = envelope({
      'ns/Todo': [
        { id: '1', title: 'a', body: 'big', _metadata: { createdAt: 'x' } },
        { id: '2', title: 'b', body: 'big', _metadata: { createdAt: 'y' } }
      ]
    });
    const frame: Frame = {
      'ns/Todo': { fields: { id: true, title: true } }
    };
    const out = projectEnvelope(env, frame);
    expect(out.data['ns/Todo']).toEqual([
      { id: '1', title: 'a' },
      { id: '2', title: 'b' }
    ]);
  });

  it('passes through entries with no fields selection (full row)', () => {
    const env = envelope({
      'ns/Todo': [{ id: '1', title: 'a', body: 'big' }]
    });
    const frame: Frame = { 'ns/Todo': { params: { limit: 1 } } };
    const out = projectEnvelope(env, frame);
    expect(out.data['ns/Todo']).toEqual([{ id: '1', title: 'a', body: 'big' }]);
  });

  it('passes through batched (array) op-keys without projection', () => {
    const env = envelope({ 'ns/createTodo': [{ id: '1' }, { id: '2' }] });
    const frame: Frame = {
      'ns/createTodo': [
        { params: { title: 'a' }, fields: { id: true } },
        { params: { title: 'b' }, fields: { id: true } }
      ]
    };
    const out = projectEnvelope(env, frame);
    expect(out.data['ns/createTodo']).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('passes through unknown keys (engine-injected error rows)', () => {
    const env = envelope({ 'ns/missing': null });
    const out = projectEnvelope(env, {});
    expect(out.data['ns/missing']).toBeNull();
  });

  it('preserves envelope metadata (errors, shapes, _pagination, schemaVersion)', () => {
    const env: PackEnvelope = {
      schemaVersion: 'svX',
      data: { 'ns/Todo': { id: '1', title: 'a', body: 'b' } },
      shapes: { 'ns/Todo': 'single' },
      errors: [{ message: 'noop' }],
      _pagination: { 'ns/Todo': { hasMore: false } }
    };
    const frame: Frame = { 'ns/Todo': { fields: { id: true } } };
    const out = projectEnvelope(env, frame);
    expect(out.schemaVersion).toBe('svX');
    expect(out.shapes).toEqual({ 'ns/Todo': 'single' });
    expect(out.errors).toEqual([{ message: 'noop' }]);
    expect(out._pagination).toEqual({ 'ns/Todo': { hasMore: false } });
    expect(out.data['ns/Todo']).toEqual({ id: '1' });
  });

  it('projects single-shape (object) entries the same as list elements', () => {
    const env = envelope({ 'ns/Todo': { id: '1', title: 'a', body: 'huge' } });
    const frame: Frame = { 'ns/Todo': { fields: { id: true, title: true } } };
    const out = projectEnvelope(env, frame);
    expect(out.data['ns/Todo']).toEqual({ id: '1', title: 'a' });
  });
});

describe('projectWsFrame', () => {
  function fieldsMap(entries: Array<[string, FieldInput]>): Map<string, FieldInput> {
    return new Map(entries);
  }

  it('projects snapshot list rows against the per-key fields map', () => {
    const frame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'snapshot',
      schemaVersion: 'sv',
      data: {
        'ns/Memory': [
          { id: '1', shortId: 11, body: 'big-body', synopsis: 'syn' },
          { id: '2', shortId: 12, body: 'big-body', synopsis: 'syn' }
        ]
      },
      shapes: { 'ns/Memory': 'list' }
    };
    const out = projectWsFrame(frame, fieldsMap([['ns/Memory', { id: true, shortId: true }]]));
    expect(out.data).toEqual({
      'ns/Memory': [
        { id: '1', shortId: 11 },
        { id: '2', shortId: 12 }
      ]
    });
  });

  it('projects single-shape add/update push frames', () => {
    const frame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'add',
      schemaVersion: 'sv',
      data: { 'ns/Memory': { id: '3', shortId: 13, body: 'b', synopsis: 's' } },
      shapes: { 'ns/Memory': 'single' }
    };
    const out = projectWsFrame(frame, fieldsMap([['ns/Memory', { id: true }]]));
    expect(out.data).toEqual({ 'ns/Memory': { id: '3' } });
  });

  it('passes through frames with no data (error/end/remove)', () => {
    const errFrame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'error',
      errors: [{ message: 'boom' }]
    };
    expect(projectWsFrame(errFrame, fieldsMap([['ns/Memory', { id: true }]]))).toBe(errFrame);

    const endFrame: WsResponseFrame = { id: 'sub-1', kind: 'end', final: true };
    expect(projectWsFrame(endFrame, fieldsMap([['ns/Memory', { id: true }]]))).toBe(endFrame);

    const removeFrame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'remove',
      schemaVersion: 'sv',
      removedId: '7'
    };
    expect(projectWsFrame(removeFrame, fieldsMap([['ns/Memory', { id: true }]]))).toBe(removeFrame);
  });

  it('passes through entries without a fields entry in the map', () => {
    const frame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'snapshot',
      schemaVersion: 'sv',
      data: { 'ns/Memory': [{ id: '1', body: 'b' }] },
      shapes: { 'ns/Memory': 'list' }
    };
    const out = projectWsFrame(frame, fieldsMap([]));
    expect(out.data).toEqual({ 'ns/Memory': [{ id: '1', body: 'b' }] });
  });

  it('preserves envelope-like metadata (id, kind, schemaVersion, shapes)', () => {
    const frame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'snapshot',
      schemaVersion: 'svX',
      data: { 'ns/Memory': [{ id: '1', body: 'b' }] },
      shapes: { 'ns/Memory': 'list' }
    };
    const out = projectWsFrame(frame, fieldsMap([['ns/Memory', { id: true }]]));
    expect(out.id).toBe('sub-1');
    expect(out.kind).toBe('snapshot');
    expect(out.schemaVersion).toBe('svX');
    expect(out.shapes).toEqual({ 'ns/Memory': 'list' });
    expect(out.data).toEqual({ 'ns/Memory': [{ id: '1' }] });
  });

  it('returns the same frame reference when fieldsByKey is undefined', () => {
    const frame: WsResponseFrame = {
      id: 'sub-1',
      kind: 'snapshot',
      schemaVersion: 'sv',
      data: { 'ns/Memory': [{ id: '1', body: 'b' }] },
      shapes: { 'ns/Memory': 'list' }
    };
    expect(projectWsFrame(frame, undefined)).toBe(frame);
  });
});

/**
 * Degradation markers survive projection.
 *
 * A read through a degraded bridge is given a marker by the engine:
 * `{ __orphan: true, reason: 'bridge_unreachable' }` (§6.5 — reads never
 * fail). `projectValue` builds its output from ONLY the selected fields and
 * nobody selects `__orphan`/`reason`, so without special handling the caller
 * receives a bare `{}`, indistinguishable from an empty result.
 *
 * These are control keys, not row fields: they are preserved regardless of the
 * projection, and only on a value that actually carries the marker.
 */
describe('degradation markers survive projection', () => {
  it('preserves __orphan and reason when the projection asks for neither', () => {
    const out = projectValue({ __orphan: true, reason: 'bridge_unreachable' }, { id: true });
    expect(out).toEqual({ __orphan: true, reason: 'bridge_unreachable' });
  });

  it('keeps the marker through a whole envelope projection', () => {
    const env = envelope({ 'ns/Widget': { __orphan: true, reason: 'bridge_unreachable' } });
    const out = projectEnvelope(env, {
      'ns/Widget': { fields: { id: true, title: true } }
    } as Frame);
    expect(out.data['ns/Widget']).toEqual({ __orphan: true, reason: 'bridge_unreachable' });
  });

  it('does not treat an ordinary row as a marker', () => {
    const out = projectValue({ id: '1', reason: 'user supplied', body: 'b' }, { id: true });
    expect(out).toEqual({ id: '1' });
  });

  it('still projects normally inside a list', () => {
    const out = projectValue([{ id: '1', body: 'b' }], { id: true });
    expect(out).toEqual([{ id: '1' }]);
  });
});

describe('walk results', () => {
  it('JSON projection keeps nested selections and _truncated', () => {
    const fields = {
      title: true,
      _agg: { n: { in: 'default/Note.todo', count: true } },
      notes: {
        _walk: { in: 'default/Note.todo' },
        fields: { body: true, replies: { _walk: { in: 'default/Reply.note' }, fields: {} } },
        limit: 1
      }
    } as unknown as FieldInput;
    const row = {
      id: 't1',
      title: 'alpha',
      body: 'hidden',
      _metadata: { createdAt: 'now' },
      _agg: { n: 2 },
      notes: [{ id: 'n1', body: 'first', replies: [{ id: 'r1' }] }],
      _truncated: { notes: true }
    };
    expect(projectValue(row, fields)).toEqual({
      title: 'alpha',
      _agg: { n: 2 },
      notes: [{ id: 'n1', body: 'first', replies: [{ id: 'r1' }] }],
      _truncated: { notes: true }
    });
  });

  it('count and groups pass through unprojected', () => {
    const env: PackEnvelope = {
      schemaVersion: 'sv',
      data: {
        'default/Todo': { count: 3 },
        'default/Note': { groups: [{ n: 3 }], truncated: true }
      },
      shapes: { 'default/Todo': 'count', 'default/Note': 'groups' }
    };
    const frame: Frame = {
      'default/Todo': { params: { count: true }, fields: { id: true } },
      'default/Note': { params: {}, fields: { id: true } }
    };
    expect(projectEnvelope(env, frame).data).toEqual(env.data);
  });
});
