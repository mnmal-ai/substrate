import { encodeEnvelope } from '@mnmal-ai/substrate-pack';
import { describe, expect, it } from 'vitest';
import { decodeJsonEnvelope, decodePackEnvelope, isPackMarker } from '../src/wire/json.js';

describe('decodeJsonEnvelope', () => {
  it('returns the envelope unchanged', () => {
    const env = { schemaVersion: 'v1', data: { foo: 'bar' }, shapes: {} };
    expect(decodeJsonEnvelope(env as never)).toEqual(env);
  });

  it('rejects envelopes missing schemaVersion', () => {
    expect(() => decodeJsonEnvelope({ data: {}, shapes: {} } as never)).toThrow(/schemaVersion/);
  });
});

describe('isPackMarker', () => {
  it('recognises __packBytes marker objects', () => {
    expect(isPackMarker({ __packBytes: new Uint8Array([1]) })).toBe(true);
  });

  it('rejects raw Uint8Array', () => {
    expect(isPackMarker(new Uint8Array([1]))).toBe(false);
  });

  it('rejects plain envelope', () => {
    expect(isPackMarker({ schemaVersion: 'v1' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isPackMarker(null)).toBe(false);
  });
});

describe('decodePackEnvelope', () => {
  it('unpacks msgpack bytes from a __packBytes marker into a raw envelope', () => {
    // Build a pack envelope. encodeEnvelope requires a full EncodeEnvelopeCtx so
    // we use a minimal one-type schema with one scalar field.
    const schema = {
      schemaVersion: 'v1',
      types: {
        Todo: {
          fields: { id: { kind: 'scalar' as const, type: 'number' as const } }
        }
      },
      mutations: {}
    };
    const envelope = {
      schemaVersion: 'v1',
      data: { 'default/Todo': [{ id: 1 }] },
      shapes: { 'default/Todo': 'list' as const }
    };
    const bytes = encodeEnvelope(envelope, {
      fieldsByKey: { 'default/Todo': { id: true } },
      typeByKey: { 'default/Todo': 'Todo' },
      currentNsByKey: { 'default/Todo': 'default' },
      schemas: { default: schema }
    });

    // Wire layer: unpack bytes from the marker into the raw envelope.
    // data values are still positional tuples — executor layer handles positional decode.
    const marker = { __packBytes: new Uint8Array(bytes) };
    const raw = decodePackEnvelope(marker);
    expect(raw.schemaVersion).toBe('v1');
    expect(raw.shapes['default/Todo']).toBe('list');
    // data holds the msgpack-decoded value — positional tuples, not named objects yet
    expect(Array.isArray(raw.data['default/Todo'])).toBe(true);
  });

  it('also accepts raw Uint8Array (WS pack frame path)', () => {
    const schema = {
      schemaVersion: 'v1',
      types: { Todo: { fields: { id: { kind: 'scalar' as const, type: 'number' as const } } } },
      mutations: {}
    };
    const envelope = {
      schemaVersion: 'v1',
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' as const }
    };
    const bytes = new Uint8Array(
      encodeEnvelope(envelope, {
        fieldsByKey: { 'default/Todo': { id: true } },
        typeByKey: { 'default/Todo': 'Todo' },
        currentNsByKey: { 'default/Todo': 'default' },
        schemas: { default: schema }
      })
    );
    const raw = decodePackEnvelope(bytes);
    expect(raw.schemaVersion).toBe('v1');
  });
});
