/**
 * `indexes` on a type: declared composite and unique indexes, checked when the
 * namespace is defined so a bad declaration never reaches the reconciler.
 */

import { describe, expect, it } from 'vitest';
import { field } from '../src/field.js';
import { defineNamespace, type TypeInput } from '../src/namespace.js';

const fields = {
  cert: field.string(),
  observedAt: field.date(),
  owner: field.crossRef('app', 'Owner'),
  tags: field.list(field.string(), { indexed: true }),
  archived: field.boolean()
};

const define = (indexes: NonNullable<TypeInput['indexes']>) =>
  defineNamespace('app', { Observation: { fields, indexes } });

describe('defineNamespace indexes', () => {
  it('accepts a composite with a direction, a unique live index and a restricted predicate', () => {
    const ns = define([
      { fields: ['cert', { field: 'observedAt', dir: 'desc' }] },
      { fields: ['owner'], unique: true, where: 'live', name: 'rows_obs_owner_uniq' },
      { fields: ['cert'], where: { archived: false } }
    ]);
    expect(ns.types?.Observation?.indexes).toHaveLength(3);
  });

  it('rejects an unknown field', () => {
    expect(() => define([{ fields: ['nope'] }])).toThrow(/nope/);
  });

  it('rejects a list field in a composite', () => {
    expect(() => define([{ fields: ['cert', 'tags'] }])).toThrow(/tags/);
  });

  it("rejects dir: 'up'", () => {
    expect(() => define([{ fields: [{ field: 'observedAt', dir: 'up' as 'asc' }] }])).toThrow(
      /dir/
    );
  });

  it('rejects an unknown field in the predicate', () => {
    expect(() => define([{ fields: ['cert'], where: { gone: true } }])).toThrow(/gone/);
  });

  it('rejects a predicate value that is not a boolean or null, naming the field', () => {
    expect(() =>
      define([{ fields: ['cert'], where: { cert: 'x' } as unknown as Record<string, boolean> }])
    ).toThrow(/where\.cert/);
  });

  it('rejects a name ending in the swap suffix', () => {
    expect(() => define([{ fields: ['cert'], name: 'rows_x__swap' }])).toThrow(/__swap/);
  });

  it('rejects a name that is not a short identifier', () => {
    expect(() => define([{ fields: ['cert'], name: 'Bad Name' }])).toThrow(/name/);
    expect(() => define([{ fields: ['cert'], name: 'x'.repeat(64) }])).toThrow(/name/);
  });
});
