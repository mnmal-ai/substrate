import { describe, expect, it } from 'vitest';
import {
  METADATA_AUTHOR_FIELDS,
  METADATA_FILTER_FIELDS,
  normaliseMetadataOrderBy,
  normaliseMetadataWhere
} from '../src/metadata-filter.js';
import type { FieldDef } from '../src/schema.js';

const NONE: Record<string, FieldDef> = {};
const KID = 'agent-1@example';

describe('normaliseMetadataWhere', () => {
  it('maps createdBy with a string operand onto createdById, every operator', () => {
    expect(normaliseMetadataWhere({ createdBy: { eq: KID } }, NONE)).toEqual({
      createdById: { eq: KID }
    });
    expect(normaliseMetadataWhere({ updatedBy: { startsWith: 'agent', neq: KID } }, NONE)).toEqual({
      updatedById: { startsWith: 'agent', neq: KID }
    });
    expect(normaliseMetadataWhere({ createdBy: { in: [KID, 'x'] } }, NONE)).toEqual({
      createdById: { in: [KID, 'x'] }
    });
    expect(normaliseMetadataWhere({ createdBy: { eq: null } }, NONE)).toEqual({
      createdById: { eq: null }
    });
  });

  it('matches both halves for an object operand, the shape _metadata returns', () => {
    expect(normaliseMetadataWhere({ createdBy: { eq: { kind: 'agent', id: KID } } }, NONE)).toEqual(
      { AND: [{ createdById: { eq: KID }, createdByKind: { eq: 'agent' } }] }
    );
    expect(normaliseMetadataWhere({ createdBy: { eq: { kind: 'user' } } }, NONE)).toEqual({
      AND: [{ createdByKind: { eq: 'user' } }]
    });
    expect(
      normaliseMetadataWhere({ createdBy: { neq: { kind: 'agent', id: KID } } }, NONE)
    ).toEqual({ AND: [{ NOT: { createdById: { eq: KID }, createdByKind: { eq: 'agent' } } }] });
  });

  it('splits in/nin between plain ids and objects', () => {
    expect(
      normaliseMetadataWhere({ createdBy: { in: ['a', { kind: 'user', id: 'b' }] } }, NONE)
    ).toEqual({
      AND: [
        {
          OR: [
            { createdById: { in: ['a'] } },
            { createdById: { eq: 'b' }, createdByKind: { eq: 'user' } }
          ]
        }
      ]
    });
    expect(normaliseMetadataWhere({ createdBy: { nin: [{ id: 'b' }] } }, NONE)).toEqual({
      AND: [{ NOT: { OR: [{ createdById: { eq: 'b' } }] } }]
    });
  });

  it('accepts the sub-field form, the dotted form and a path predicate', () => {
    expect(
      normaliseMetadataWhere({ createdBy: { id: { eq: KID }, kind: { eq: 'agent' } } }, NONE)
    ).toEqual({ createdById: { eq: KID }, createdByKind: { eq: 'agent' } });
    expect(normaliseMetadataWhere({ 'createdBy.id': { eq: KID } }, NONE)).toEqual({
      createdById: { eq: KID }
    });
    expect(normaliseMetadataWhere({ createdBy: { path: ['kind'], eq: 'agent' } }, NONE)).toEqual({
      createdByKind: { eq: 'agent' }
    });
  });

  it('flattens the _metadata read shape, nested or dotted', () => {
    expect(
      normaliseMetadataWhere(
        { _metadata: { createdBy: { eq: KID }, createdAt: { gt: '2026-10-01' } } },
        NONE
      )
    ).toEqual({ createdById: { eq: KID }, createdAt: { gt: '2026-10-01' } });
    expect(normaliseMetadataWhere({ '_metadata.createdBy.kind': { eq: 'agent' } }, NONE)).toEqual({
      createdByKind: { eq: 'agent' }
    });
    expect(normaliseMetadataWhere({ _metadata: { nope: { eq: 1 } } }, NONE)).toEqual({
      '_metadata.nope': { eq: 1 }
    });
  });

  it('recurses through AND / OR / NOT and keeps other keys', () => {
    expect(
      normaliseMetadataWhere(
        {
          status: { eq: 'open' },
          OR: [{ createdBy: { eq: 'a' } }, { NOT: { updatedBy: { eq: 'b' } } }]
        },
        NONE
      )
    ).toEqual({
      status: { eq: 'open' },
      OR: [{ createdById: { eq: 'a' } }, { NOT: { updatedById: { eq: 'b' } } }]
    });
  });

  it('combines rather than overwrites when two spellings name the same column', () => {
    expect(
      normaliseMetadataWhere({ createdById: { neq: 'x' }, createdBy: { eq: 'y' } }, NONE)
    ).toEqual({ AND: [{ createdById: { neq: 'x' } }, { createdById: { eq: 'y' } }] });
  });

  it('never puts a field key beside the AND it emits', () => {
    expect(
      normaliseMetadataWhere(
        { status: { eq: 'open' }, createdBy: { eq: { kind: 'agent', id: KID } } },
        NONE
      )
    ).toEqual({
      AND: [
        { status: { eq: 'open' } },
        { createdById: { eq: KID }, createdByKind: { eq: 'agent' } }
      ]
    });
  });

  it('leaves a field the type declares under that name alone', () => {
    const declared: Record<string, FieldDef> = {
      createdBy: { kind: 'scalar', type: 'string' }
    };
    expect(normaliseMetadataWhere({ createdBy: { eq: 'x' } }, declared)).toEqual({
      createdBy: { eq: 'x' }
    });
  });

  it('returns non-object input unchanged', () => {
    expect(normaliseMetadataWhere(undefined, NONE)).toBeUndefined();
    expect(normaliseMetadataWhere([1], NONE)).toEqual([1]);
  });
});

describe('normaliseMetadataOrderBy', () => {
  it('maps author and _metadata spellings onto the sortable columns', () => {
    expect(
      normaliseMetadataOrderBy(
        [
          { createdBy: 'asc' },
          { '_metadata.createdAt': 'desc' },
          { 'updatedBy.kind': 'asc' },
          { title: 'asc' }
        ],
        NONE
      )
    ).toEqual([
      { createdById: 'asc' },
      { createdAt: 'desc' },
      { updatedByKind: 'asc' },
      { title: 'asc' }
    ]);
  });
});

describe('published tables', () => {
  it('names every metadata filter column and both author aliases', () => {
    expect(Object.keys(METADATA_FILTER_FIELDS).sort()).toEqual([
      'createdAt',
      'createdById',
      'createdByKind',
      'id',
      'seq',
      'updatedAt',
      'updatedById',
      'updatedByKind'
    ]);
    expect(METADATA_AUTHOR_FIELDS).toEqual({
      createdBy: { id: 'createdById', kind: 'createdByKind' },
      updatedBy: { id: 'updatedById', kind: 'updatedByKind' }
    });
  });
});
