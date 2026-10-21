/**
 * Unit tests for the lifted WS framing codec + decode plan.
 *
 * Covers:
 *  - encodeWsFrame: json → string, pack → Uint8Array
 *  - decodeWsEnvelope: json string, pack ArrayBuffer/Uint8Array, JSON-over-binary fallback
 *  - buildDecodePlan: well-formed entries, undefined-fields skip, malformed key skip,
 *    missing-schema skip, multi-key, opts reference stability
 *  - applyDecodePlanInPlace: snapshot/add/update/chunk decode in place,
 *    no-op on remove/end/error, missing-key tolerance, multi-key plans
 */

import type { Schema } from '@mnmal-ai/substrate-types';
import { Packr, pack, unpack } from 'msgpackr';
import { describe, expect, it } from 'vitest';

import {
  applyDecodePlanInPlace,
  buildDecodePlan,
  decodeWsEnvelope,
  encodeWsFrame,
  isPlainRequestData
} from '../src/wire.js';

const todoSchema: Schema = {
  schemaVersion: 'wire-test-aa',
  types: {
    Todo: {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' }
      }
    }
  },
  mutations: {}
};

const tagSchema: Schema = {
  schemaVersion: 'wire-test-bb',
  types: {
    Tag: {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        label: { kind: 'scalar', type: 'string' }
      }
    }
  },
  mutations: {}
};

const stubSchemas = { default: todoSchema };

describe('encodeWsFrame', () => {
  it('returns a JSON string in json mode', () => {
    const out = encodeWsFrame({ id: 'x', op: 'subscribe' }, 'json');
    expect(typeof out).toBe('string');
    expect(JSON.parse(out as string)).toEqual({ id: 'x', op: 'subscribe' });
  });

  it('returns msgpack bytes in pack mode', () => {
    const out = encodeWsFrame({ id: 'y', op: 'cancel' }, 'pack');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(unpack(out as Uint8Array)).toEqual({ id: 'y', op: 'cancel' });
  });
});

describe('decodeWsEnvelope', () => {
  it('parses a JSON string in json mode', () => {
    const raw = JSON.stringify({ id: 'x', kind: 'snapshot' });
    expect(decodeWsEnvelope(raw, 'json')).toEqual({ id: 'x', kind: 'snapshot' });
  });

  it('refuses a cyclic structured-clone payload in pack mode', () => {
    const where: Record<string, unknown> = {};
    where.NOT = where;
    const bytes = new Packr({ structuredClone: true }).pack({ f: { where } });
    expect(() => decodeWsEnvelope(bytes, 'pack')).toThrow(/structured clone/i);
  });

  it('decodes msgpack from a Uint8Array in pack mode', () => {
    const bytes = pack({ id: 'y', kind: 'add' });
    expect(decodeWsEnvelope(bytes, 'pack')).toEqual({ id: 'y', kind: 'add' });
  });

  it('decodes msgpack from an ArrayBuffer in pack mode', () => {
    const u8 = pack({ id: 'z', kind: 'remove', removedId: 'r' });
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    expect(decodeWsEnvelope(ab, 'pack')).toEqual({ id: 'z', kind: 'remove', removedId: 'r' });
  });

  it('falls back to utf-8 decode when JSON arrives as binary', () => {
    const raw = Buffer.from(JSON.stringify({ id: 'fb', kind: 'end', final: true }), 'utf8');
    expect(decodeWsEnvelope(raw, 'json')).toEqual({ id: 'fb', kind: 'end', final: true });
  });

  it('returns the caller-specified type via the generic parameter', () => {
    interface Frame {
      id: string;
      kind: string;
    }
    const out = decodeWsEnvelope<Frame>(JSON.stringify({ id: 'g', kind: 'snapshot' }), 'json');
    expect(out.id).toBe('g');
    expect(out.kind).toBe('snapshot');
  });

  it('terminal teardown frames round-trip pack mode with code/reason/final intact', () => {
    const errorFrame = {
      id: 'sub-1',
      kind: 'error',
      errors: [
        {
          message: "subscription 'sub-1' queue threshold exceeded",
          code: 'subscription_overloaded'
        }
      ]
    };
    const endFrame = { id: 'sub-1', kind: 'end', final: true, reason: 'subscription_overloaded' };

    for (const frame of [errorFrame, endFrame]) {
      const wire = encodeWsFrame(frame, 'pack');
      expect(typeof wire).not.toBe('string');
      const decoded = decodeWsEnvelope<typeof frame>(wire, 'pack');
      expect(decoded).toEqual(frame);
    }
  });
});

describe('buildDecodePlan', () => {
  it('returns an entry for a valid qkey with fields defined', () => {
    const frameSpec = {
      'default/Todo': { params: {}, fields: { id: true, title: true } }
    };
    const plan = buildDecodePlan(frameSpec, stubSchemas);
    expect(plan).toHaveLength(1);
    const entry = plan[0];
    expect(entry?.qkey).toBe('default/Todo');
    expect(entry?.name).toBe('Todo');
    expect(entry?.schema).toBe(todoSchema);
    expect(entry?.fields).toEqual({ id: true, title: true });
    expect(entry?.opts).toEqual({ schemas: stubSchemas, currentNs: 'default' });
  });

  it('skips keys where fields is undefined', () => {
    const frameSpec = { 'default/Todo': { params: {} } };
    const plan = buildDecodePlan(frameSpec, stubSchemas);
    expect(plan).toHaveLength(0);
  });

  it('skips keys with no matching schema', () => {
    const frameSpec = {
      'unknown/Todo': { params: {}, fields: { id: true } }
    };
    const plan = buildDecodePlan(frameSpec, stubSchemas);
    expect(plan).toHaveLength(0);
  });

  it('skips keys with malformed qualified shape (no slash)', () => {
    const frameSpec = { badkey: { params: {}, fields: { id: true } } };
    const plan = buildDecodePlan(frameSpec, stubSchemas);
    expect(plan).toHaveLength(0);
  });

  it('builds multi-qkey plan with independent entries', () => {
    const schemas = { default: todoSchema, tags: tagSchema };
    const frameSpec = {
      'default/Todo': { params: {}, fields: { id: true } },
      'tags/Tag': { params: {}, fields: { label: true } }
    };
    const plan = buildDecodePlan(frameSpec, schemas);
    expect(plan).toHaveLength(2);

    const todoEntry = plan.find((e) => e.qkey === 'default/Todo');
    const tagEntry = plan.find((e) => e.qkey === 'tags/Tag');

    expect(todoEntry?.name).toBe('Todo');
    expect(todoEntry?.opts.currentNs).toBe('default');
    expect(tagEntry?.name).toBe('Tag');
    expect(tagEntry?.opts.currentNs).toBe('tags');
  });

  it('opts object is shared by reference within a plan entry', () => {
    const frameSpec = { 'default/Todo': { params: {}, fields: { id: true } } };
    const plan = buildDecodePlan(frameSpec, stubSchemas);
    const opts1 = plan[0]?.opts;
    const opts2 = plan[0]?.opts;
    expect(opts1).toBe(opts2);
  });
});

describe('applyDecodePlanInPlace', () => {
  const plan = buildDecodePlan(
    { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
    stubSchemas
  );

  it('decodes positional rows into named objects on a snapshot frame', () => {
    const ev = { kind: 'snapshot' as const, data: { 'default/Todo': ['1', 'first'] } };
    applyDecodePlanInPlace(ev, plan);
    expect(ev.data['default/Todo']).toEqual({ id: '1', title: 'first' });
  });

  it('decodes data on an add frame', () => {
    const ev = { kind: 'add' as const, data: { 'default/Todo': ['2', 'added'] } };
    applyDecodePlanInPlace(ev, plan);
    expect(ev.data['default/Todo']).toEqual({ id: '2', title: 'added' });
  });

  it('decodes data on an update frame', () => {
    const ev = { kind: 'update' as const, data: { 'default/Todo': ['3', 'updated'] } };
    applyDecodePlanInPlace(ev, plan);
    expect(ev.data['default/Todo']).toEqual({ id: '3', title: 'updated' });
  });

  it('decodes data on a chunk frame', () => {
    const ev = { kind: 'chunk' as const, data: { 'default/Todo': ['4', 'chunked'] } };
    applyDecodePlanInPlace(ev, plan);
    expect(ev.data['default/Todo']).toEqual({ id: '4', title: 'chunked' });
  });

  it('is a no-op on a remove frame (no data property)', () => {
    const ev = { kind: 'remove' as const, removedId: 'r1' };
    expect(() => applyDecodePlanInPlace(ev, plan)).not.toThrow();
  });

  it('is a no-op on an end frame', () => {
    const ev = { kind: 'end' as const, final: true };
    expect(() => applyDecodePlanInPlace(ev, plan)).not.toThrow();
  });

  it('is a no-op on an error frame', () => {
    const ev = { kind: 'error' as const, errors: [{ message: 'oops' }] };
    expect(() => applyDecodePlanInPlace(ev, plan)).not.toThrow();
  });

  it('skips silently when a plan entry is absent from the frame data map', () => {
    const ev = { kind: 'snapshot' as const, data: { 'other/Thing': [1, 2] } };
    applyDecodePlanInPlace(ev, plan);
    expect(ev.data['other/Thing']).toEqual([1, 2]);
  });

  it('decodes multiple qkeys in one frame using independent plan entries', () => {
    const schemas = { default: todoSchema, tags: tagSchema };
    const multiPlan = buildDecodePlan(
      {
        'default/Todo': { params: {}, fields: { id: true, title: true } },
        'tags/Tag': { params: {}, fields: { id: true, label: true } }
      },
      schemas
    );
    expect(multiPlan).toHaveLength(2);

    const ev = {
      kind: 'snapshot' as const,
      data: { 'default/Todo': ['10', 'multi-todo'], 'tags/Tag': ['20', 'tag-label'] }
    };
    applyDecodePlanInPlace(ev, multiPlan);

    expect(ev.data['default/Todo']).toEqual({ id: '10', title: 'multi-todo' });
    expect(ev.data['tags/Tag']).toEqual({ id: '20', label: 'tag-label' });
  });

  it('tolerates non-object envelopes', () => {
    expect(() => applyDecodePlanInPlace(null, plan)).not.toThrow();
    expect(() => applyDecodePlanInPlace(undefined, plan)).not.toThrow();
    expect(() => applyDecodePlanInPlace('string', plan)).not.toThrow();
  });
});

describe('isPlainRequestData', () => {
  it('accepts JSON-shaped requests and dates', () => {
    const frame = decodeWsEnvelope(
      pack({
        id: 's1',
        op: 'subscribe',
        frame: { 'app/T': { params: { where: { at: { gt: new Date(0) } } } } }
      }),
      'pack'
    );
    expect(isPlainRequestData(frame)).toBe(true);
  });

  it('refuses the extension types that survive decoding, and deep nesting', () => {
    // RegExp, Set and Map arrive as plain arrays and objects with structured clone off.
    for (const exotic of [10n, new Uint8Array([1])]) {
      const frame = decodeWsEnvelope(
        pack({ id: 's1', op: 'subscribe', frame: { v: exotic } }),
        'pack'
      );
      expect(isPlainRequestData(frame)).toBe(false);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = { d: deep };
    expect(isPlainRequestData(deep)).toBe(false);
  });
});
