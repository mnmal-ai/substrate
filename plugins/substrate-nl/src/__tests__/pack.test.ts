import type { Schema } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { buildNamespacePack } from '../pack/build.js';
import { profileNamespace } from '../pack/profile.js';
import type { NamespaceProfile } from '../pack/types.js';

const OPERATORS = {
  'scalar.string': ['contains', 'eq', 'in', 'startsWith'],
  'scalar.number': ['eq', 'gt', 'in'],
  'scalar.boolean': ['eq'],
  'scalar.date': ['between', 'gte', 'lt'],
  crossRef: ['eq', 'in'],
  list: ['has']
};

const schema: Schema = {
  schemaVersion: 'abc123def456',
  mutations: {},
  types: {
    Todo: {
      fields: {
        title: { kind: 'scalar', type: 'string', indexed: true },
        area: { kind: 'scalar', type: 'string', indexed: true },
        status: { kind: 'scalar', type: 'string', indexed: true, enum: ['open', 'done'] },
        project: { kind: 'scalar', type: 'string', indexed: true, nullable: true },
        notes: { kind: 'scalar', type: 'string', indexed: false },
        targetDate: { kind: 'scalar', type: 'date', indexed: true },
        tags: {
          kind: 'list',
          of: { kind: 'scalar', type: 'string', indexed: true },
          indexed: true
        },
        owner: {
          kind: 'crossRef',
          ns: 'journal',
          type: 'AgentIdentity',
          onDelete: 'set_null',
          indexed: true
        },
        shortId: { kind: 'scalar', type: 'number', indexed: true, readonly: true }
      }
    },
    AgentMessage: {
      fields: {
        subject: { kind: 'scalar', type: 'string', indexed: true },
        status: { kind: 'scalar', type: 'string', indexed: true, enum: ['unread', 'read', 'acked'] }
      }
    },
    Decision: {
      fields: { project: { kind: 'scalar', type: 'string', indexed: true } }
    }
  }
};

const titles = Array.from(
  { length: 100 },
  (_, i) => `fix the thing that broke on day ${i} of the release`
);
const areas = Array.from({ length: 300 }, (_, i) => `area-${i}`);
const profile: NamespaceProfile = {
  types: {
    Todo: {
      project: { values: ['labs', 'substrate'], truncated: false },
      title: { values: titles, truncated: false },
      area: { values: areas, truncated: false },
      notes: { values: ['an unindexed note'], truncated: false },
      tags: { values: ['recall', 'release'], truncated: false }
    },
    Decision: { project: { values: ['holomap', 'substrate'], truncated: false } }
  }
};

const build = () =>
  buildNamespacePack({ namespace: 'journal', schema, operators: OPERATORS, profile });

describe('buildNamespacePack', () => {
  it('names each type by singular, plural and head noun', () => {
    const pack = build();
    expect(pack.types.Todo?.phrases).toEqual(['todo', 'todos']);
    expect(pack.types.AgentMessage?.phrases).toEqual([
      'agent message',
      'agent messages',
      'message',
      'messages'
    ]);
  });

  it('splits camelCase field names into phrases', () => {
    const pack = build();
    expect(pack.types.Todo?.fields.shortId?.phrases).toEqual(['short id', 'shortid']);
    expect(pack.types.Todo?.fields.targetDate?.phrases).toEqual(['target date', 'targetdate']);
    expect(pack.types.Todo?.fields.status?.phrases).toEqual(['status']);
  });

  it('attaches the operators each field kind accepts', () => {
    const f = build().types.Todo?.fields;
    expect(f?.status?.operators).toEqual(OPERATORS['scalar.string']);
    expect(f?.targetDate?.operators).toEqual(OPERATORS['scalar.date']);
    expect(f?.owner).toMatchObject({
      kind: 'crossRef',
      target: 'AgentIdentity',
      operators: ['eq', 'in']
    });
    expect(f?.tags).toMatchObject({ kind: 'list', operators: ['has'] });
  });

  it('adds the filterable metadata virtuals to every type', () => {
    const f = build().types.Decision?.fields;
    expect(f?.createdAt).toMatchObject({
      kind: 'metadata',
      valueType: 'date',
      operators: OPERATORS['scalar.date']
    });
    expect(f?.createdById).toMatchObject({ kind: 'metadata', valueType: 'string' });
    expect(f?.createdById?.phrases).toContain('created by');
  });

  it('indexes enum values even when the profile never saw them', () => {
    expect(build().values.acked).toEqual([
      { type: 'AgentMessage', field: 'status', value: 'acked' }
    ]);
  });

  it('indexes profiled values of indexed low-cardinality fields, and list elements', () => {
    const v = build().values;
    expect(v.labs).toEqual([{ type: 'Todo', field: 'project', value: 'labs' }]);
    expect(v.recall).toEqual([{ type: 'Todo', field: 'tags', value: 'recall' }]);
  });

  it('keeps every reference when one value belongs to several fields', () => {
    expect(build().values.substrate).toEqual([
      { type: 'Decision', field: 'project', value: 'substrate' },
      { type: 'Todo', field: 'project', value: 'substrate' }
    ]);
  });

  it('treats many short labels as vocabulary, and prose as not', () => {
    const v = build().values;
    expect(v['area-250']).toEqual([{ type: 'Todo', field: 'area', value: 'area-250' }]);
    expect(v[titles[7] as string]).toBeUndefined();
  });

  it('leaves out prose even when it has few distinct values', () => {
    const pack = buildNamespacePack({
      namespace: 'journal',
      schema,
      operators: OPERATORS,
      profile: {
        types: {
          Todo: {
            title: { values: ['a long sentence about one particular thing'], truncated: false }
          }
        }
      }
    });
    expect(pack.values['a long sentence about one particular thing']).toBeUndefined();
  });

  it('records the distinct count of a vocabulary field', () => {
    const f = build().types.Todo?.fields;
    expect(f?.project?.distinct).toBe(2);
    expect(f?.area?.distinct).toBe(300);
    expect(f?.title?.distinct).toBeUndefined();
  });

  it('leaves out unindexed fields', () => {
    expect(build().values['an unindexed note']).toBeUndefined();
  });

  it('leaves out a field whose profile was truncated', () => {
    const pack = buildNamespacePack({
      namespace: 'journal',
      schema,
      operators: OPERATORS,
      profile: { types: { Todo: { project: { values: ['labs'], truncated: true } } } }
    });
    expect(pack.values.labs).toBeUndefined();
  });

  it('carries the schema version and is deterministic', () => {
    const a = build();
    expect(a.schemaVersion).toBe('abc123def456');
    expect(JSON.stringify(build())).toBe(JSON.stringify(a));
    expect(Object.keys(a.types)).toEqual(['AgentMessage', 'Decision', 'Todo']);
  });
});

describe('profileNamespace', () => {
  it('collects distinct values of indexed string fields and list elements, paging through rows', async () => {
    const rows = [
      { project: 'substrate', status: 'open', tags: ['recall'], notes: 'x' },
      { project: 'labs', status: 'open', tags: ['release', 'recall'], notes: 'y' },
      { project: 'substrate', status: 'done', tags: null, notes: 'z' }
    ];
    const pages: unknown[] = [];
    const read = async (type: string, fields: string[], cursor?: string) => {
      pages.push({ type, fields, cursor });
      if (type !== 'Todo') return { rows: [], nextCursor: undefined };
      const start = cursor === undefined ? 0 : Number(cursor);
      return {
        rows: rows.slice(start, start + 2),
        nextCursor: start + 2 < rows.length ? String(start + 2) : undefined
      };
    };
    const profile = await profileNamespace({ schema, read, maxDistinct: 64 });
    expect(profile.types.Todo?.project).toEqual({
      values: ['labs', 'substrate'],
      truncated: false
    });
    expect(profile.types.Todo?.tags).toEqual({ values: ['recall', 'release'], truncated: false });
    expect(profile.types.Todo?.notes).toBeUndefined();
    // Only indexed string fields and indexed string lists are requested.
    const todoPage = pages.find((p) => (p as { type: string }).type === 'Todo') as {
      fields: string[];
    };
    expect([...todoPage.fields].sort()).toEqual(['area', 'project', 'status', 'tags', 'title']);
  });

  it('marks a field truncated once it passes maxDistinct', async () => {
    const read = async (type: string) =>
      type === 'Todo'
        ? { rows: titles.map((title) => ({ title })), nextCursor: undefined }
        : { rows: [], nextCursor: undefined };
    const profile = await profileNamespace({ schema, read, maxDistinct: 10 });
    expect(profile.types.Todo?.title?.truncated).toBe(true);
    expect(profile.types.Todo?.title?.values.length).toBeLessThanOrEqual(10);
  });

  it('stops paging a type once maxRows rows have been read', async () => {
    let pages = 0;
    const read = async (type: string, _fields: string[], cursor?: string) => {
      if (type !== 'Todo') return { rows: [], nextCursor: undefined };
      pages++;
      // A low-cardinality field never truncates, so only the row budget ends this.
      const next = pages < 50 ? String(Number(cursor ?? 0) + 2) : undefined;
      return { rows: [{ status: 'open' }, { status: 'done' }], nextCursor: next };
    };
    const profile = await profileNamespace({ schema, read, maxRows: 6 });
    expect(pages).toBe(3);
    expect(profile.types.Todo?.status).toEqual({ values: ['done', 'open'], truncated: false });
  });
});

describe('vocabulary aliases from the schema', () => {
  const vocabSchema: Schema = {
    schemaVersion: 'v2',
    mutations: {},
    types: {
      Todo: {
        fields: {
          status: {
            kind: 'scalar',
            type: 'string',
            indexed: true,
            enum: ['open', 'closed'],
            aliases: { done: 'closed', 'in force': 'open' },
            implies: { done: { resolution: 'completed' } }
          },
          resolution: {
            kind: 'scalar',
            type: 'string',
            indexed: true,
            enum: ['completed', 'wont_do']
          }
        }
      }
    }
  };
  const pack = buildNamespacePack({
    namespace: 'journal',
    schema: vocabSchema,
    operators: OPERATORS
  });

  it('indexes each alias as a value of its field, verbatim, so the server applies it', () => {
    expect(pack.values.done).toEqual([{ type: 'Todo', field: 'status', value: 'done' }]);
    expect(pack.values['in force']).toEqual([{ type: 'Todo', field: 'status', value: 'in force' }]);
  });

  it('keeps the canonical values indexed too', () => {
    expect(pack.values.closed).toEqual([{ type: 'Todo', field: 'status', value: 'closed' }]);
  });

  it('records the alias table on the field', () => {
    expect(pack.types.Todo?.fields.status?.aliases).toEqual({ done: 'closed', 'in force': 'open' });
  });
});
