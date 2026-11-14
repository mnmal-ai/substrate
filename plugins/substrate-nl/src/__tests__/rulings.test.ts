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

describe('fieldPhrases', () => {
  const entries = {
    'asking price': { field: 'Listing.price', exclude: { status: { eq: 'draft' } } },
    'valued psa 9': { field: 'Cert.grade', value: 9 },
    margin: { select: { sub: ['Listing.price', 'Listing.cost'] } },
    slower: { field: 'Listing.price', pick: 'max' }
  };
  const fields = (...n: string[]) =>
    Object.fromEntries(n.map((k) => [k, { kind: 'scalar', type: 'string' }]));
  const typed = (nl: unknown): Schema =>
    ({
      ...schema({ nl }),
      types: {
        Listing: { fields: fields('price', 'cost', 'status') },
        Cert: {
          fields: {
            grade: { kind: 'scalar', type: 'int32' },
            score: { kind: 'scalar', type: 'number' },
            graded: { kind: 'scalar', type: 'boolean' },
            issued: { kind: 'scalar', type: 'date' },
            tier: { kind: 'scalar', type: 'string', enum: ['gold'], aliases: { Au: 'gold' } },
            meta: { kind: 'scalar', type: 'json' },
            tags: { kind: 'list', of: { kind: 'scalar', type: 'string' } },
            listing: { kind: 'crossRef', ns: 'x', type: 'Listing', onDelete: 'set_null' }
          }
        }
      }
    }) as unknown as Schema;

  it('accepts field, value, exclude, select and pick entries', () => {
    const r = readRulings(typed({ fieldPhrases: entries }));
    expect(r.warnings).toEqual([]);
    expect(r.rulings.fieldPhrases).toEqual(entries);
  });
  it('normalises phrases and refuses collisions', () => {
    const p = NamespaceRulingsSchema.parse({
      fieldPhrases: { '  Asking   Price ': { pick: 'min' } }
    });
    expect(Object.keys(p.fieldPhrases ?? {})).toEqual(['asking price']);
    expect(() =>
      NamespaceRulingsSchema.parse({
        fieldPhrases: { 'A b': { pick: 'min' }, 'a  B': { pick: 'max' } }
      })
    ).toThrow(/normalise/);
  });
  it('refuses value or exclude without field, and unknown keys', () => {
    expect(() => NamespaceRulingsSchema.parse({ fieldPhrases: { x: { value: 1 } } })).toThrow();
    expect(() =>
      NamespaceRulingsSchema.parse({ fieldPhrases: { x: { pick: 'min', nope: 1 } } })
    ).toThrow();
  });
  it('refuses an empty entry', () => {
    expect(() => NamespaceRulingsSchema.parse({ fieldPhrases: { x: {} } })).toThrow(/at least one/);
  });
  it('keeps metadata and nested excludes, refuses a dotless field', () => {
    const r = readRulings(
      typed({
        fieldPhrases: {
          mine: { field: 'Listing.price', exclude: { createdBy: { eq: 'x' }, id: { ne: 'y' } } },
          nested: {
            field: 'Listing.price',
            exclude: { AND: [{ OR: [{ NOT: { status: { eq: 'a' } } }] }] }
          },
          bad: { field: 'Listing.price', exclude: { NOT: { ghost: { eq: 1 } } } },
          dotless: { field: 'Listing' }
        }
      })
    );
    expect(Object.keys(r.rulings.fieldPhrases ?? {}).sort()).toEqual(['mine', 'nested']);
    expect(r.warnings).toHaveLength(2);
  });
  it('normalises override keys so a differently-cased one replaces the declared', () => {
    const r = readRulings(typed({ fieldPhrases: { 'asking price': { field: 'Listing.price' } } }), {
      fieldPhrases: { ' Asking  Price': { field: 'Listing.cost' } }
    });
    expect(r.rulings.fieldPhrases).toEqual({ 'asking price': { field: 'Listing.cost' } });
    const bad = readRulings(typed({}), { fieldPhrases: { x: { pick: 'min', nope: 1 } } } as never);
    expect(bad.rulings.fieldPhrases).toBeUndefined();
    expect(bad.warnings).toHaveLength(1);
  });
  it("keeps a value that fits the field's kind and drops one that does not, naming why", () => {
    const ok = {
      s: { field: 'Listing.status', value: 'draft' },
      i: { field: 'Cert.grade', value: 9 },
      n: { field: 'Cert.score', value: 9.5 },
      b: { field: 'Cert.graded', value: false },
      d: { field: 'Cert.issued', value: '2026-01-02' },
      e: { field: 'Cert.tier', value: 'gold' },
      alias: { field: 'Cert.tier', value: 'au' },
      ref: { field: 'Cert.listing', value: '0190a0a0-0000-7000-8000-000000000000' }
    };
    const bad = {
      numOnString: { field: 'Listing.status', value: 9 },
      stringOnInt: { field: 'Cert.grade', value: '9' },
      fraction: { field: 'Cert.grade', value: 9.5 },
      notBool: { field: 'Cert.graded', value: 'yes' },
      notDate: { field: 'Cert.issued', value: 'soon' },
      notIso: { field: 'Cert.issued', value: 'Jan 2 2026' },
      notReal: { field: 'Cert.issued', value: '2026-02-30' },
      notMember: { field: 'Cert.tier', value: 'silver' },
      json: { field: 'Cert.meta', value: 'x' },
      list: { field: 'Cert.tags', value: 'x' },
      badRef: { field: 'Cert.listing', value: 3 }
    };
    const r = readRulings(typed({ fieldPhrases: { ...ok, ...bad } }));
    expect(r.rulings.fieldPhrases).toEqual(ok);
    expect(r.warnings).toHaveLength(Object.keys(bad).length);
    expect(r.warnings.join('\n')).toMatch(
      /'numonstring'.*value for 'Listing.status' is not a string/
    );
    expect(r.warnings.join('\n')).toMatch(/'notmember'.*'silver' is not one of gold/);
    expect(r.warnings.join('\n')).toMatch(/'list'.*cannot bind a list field/);
  });
  it('refuses an entry naming an unknown type or field at load, naming the phrase', () => {
    const r = readRulings(
      typed({
        fieldPhrases: {
          a: { field: 'Nope.x' },
          b: { field: 'Listing.nope' },
          c: { field: 'Listing.price', exclude: { ghost: { eq: 1 } } },
          d: { select: { div: ['Listing.price', 'Cert.grade'] } },
          ok: { field: 'Listing.price' }
        }
      })
    );
    expect(Object.keys(r.rulings.fieldPhrases ?? {})).toEqual(['ok']);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.join('\n')).toMatch(/'a'.*Nope[\s\S]*'b'[\s\S]*'c'[\s\S]*'d'/);
  });
});

describe('typeExcludes', () => {
  const typed = (nl: unknown): Schema =>
    ({
      ...schema({ nl }),
      types: { Run: { fields: { status: { kind: 'string' } } } }
    }) as unknown as Schema;

  it('keeps a clause on known fields (metadata allowed); refuses unknown types and fields', () => {
    const r = readRulings(
      typed({
        typeExcludes: {
          Run: { OR: [{ status: { in: ['skipped'] } }, { createdBy: { eq: 'x' } }] },
          Nope: { status: { eq: 'a' } }
        }
      })
    );
    expect(Object.keys(r.rulings.typeExcludes ?? {})).toEqual(['Run']);
    expect(r.warnings).toEqual(["typeExcludes 'Nope' was ignored: unknown type 'Nope'"]);
    const bad = readRulings(typed({ typeExcludes: { Run: { ghost: { eq: 1 } } } }));
    expect(bad.rulings.typeExcludes).toEqual({});
    expect(bad.warnings[0]).toMatch(/unknown field 'Run.ghost'/);
  });
  it('is strict: a non-object clause invalidates the declared rulings', () => {
    expect(() => NamespaceRulingsSchema.parse({ typeExcludes: { Run: 'skipped' } })).toThrow();
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
