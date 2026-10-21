import type { Schema } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { mergeRulings, NamespaceRulingsSchema, readRulings } from '../rulings/schema.js';

const schema = (annotations?: Record<string, unknown>): Schema => ({
  schemaVersion: 'v',
  types: {},
  mutations: {},
  ...(annotations !== undefined ? { annotations } : {})
});

describe('NamespaceRulingsSchema', () => {
  it('accepts every documented key', () => {
    const r = {
      unscopedTypes: ['A'],
      typeAliases: { inbox: 'AgentMessage' },
      fieldAliases: { repo: 'project' },
      liveStatus: { Todo: 'open' },
      timeField: { SessionLog: 'startedAt' },
      typeNotes: { Todo: 'work' },
      valueAliases: { shipped: [{ type: 'Todo', field: 'resolution', eq: 'completed' }] }
    };
    expect(NamespaceRulingsSchema.parse(r)).toEqual(r);
  });
  it('rejects an unknown key and a value alias with two predicates', () => {
    expect(() => NamespaceRulingsSchema.parse({ liveStatuses: {} })).toThrow();
    expect(() =>
      NamespaceRulingsSchema.parse({
        valueAliases: { x: [{ type: 'T', field: 'f', eq: 'a', in: ['b'] }] }
      })
    ).toThrow(/exactly one/);
  });
});

describe('mergeRulings', () => {
  it('merges per top-level key, the override winning per entry', () => {
    const merged = mergeRulings(
      { typeAliases: { inbox: 'AgentMessage', task: 'Todo' }, liveStatus: { Todo: 'open' } },
      { typeAliases: { task: 'Decision', chore: 'Todo' }, unscopedTypes: ['Skill'] }
    );
    expect(merged).toEqual({
      typeAliases: { inbox: 'AgentMessage', task: 'Decision', chore: 'Todo' },
      liveStatus: { Todo: 'open' },
      unscopedTypes: ['Skill']
    });
  });
  it('replaces arrays rather than concatenating them', () => {
    expect(mergeRulings({ unscopedTypes: ['A'] }, { unscopedTypes: ['B'] })).toEqual({
      unscopedTypes: ['B']
    });
  });
});

describe('readRulings', () => {
  it('reads annotations.nl', () => {
    expect(readRulings(schema({ nl: { liveStatus: { Todo: 'open' } } }))).toEqual({
      rulings: { liveStatus: { Todo: 'open' } },
      warnings: []
    });
  });
  it('drops invalid declared rulings with a warning, still applying the override', () => {
    const r = readRulings(schema({ nl: { liveStatus: 'open' } }), {
      fieldAliases: { repo: 'project' }
    });
    expect(r.rulings).toEqual({ fieldAliases: { repo: 'project' } });
    expect(r.warnings[0]).toMatch(/declared rulings.*invalid.*liveStatus/);
  });
  it('no annotations means only the override', () => {
    expect(readRulings(schema(), undefined)).toEqual({ rulings: {}, warnings: [] });
  });
});
