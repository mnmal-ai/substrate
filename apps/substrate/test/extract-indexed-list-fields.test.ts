/**
 * The binary collects every `field.list({ indexed: true })` field
 * from the loaded namespace defs to auto-derive its GIN migration.
 */

import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { extractIndexedListFields } from '../src/main.js';

describe('extractIndexedListFields', () => {
  it('collects only indexed list fields, skipping unindexed lists + scalars', () => {
    const def = defineNamespace('kx', {
      Metric: {
        fields: {
          id: field.string(),
          labels: field.list(field.string(), { indexed: true }), // collected
          notes: field.list(field.string()), // unindexed list → skipped
          count: field.number() // scalar → skipped
        }
      }
    });
    const nsDefs = new Map<string, NamespaceDefinition>([['kx', def]]);
    expect(extractIndexedListFields(nsDefs)).toEqual([
      { namespace: 'kx', type: 'Metric', field: 'labels' }
    ]);
  });

  it('collects indexed json fields too — same GIN shape over (body -> field)', () => {
    const def = defineNamespace('kx', {
      Item: {
        fields: {
          values: field.json({ indexed: true }), // collected
          blob: field.json() // unindexed json → skipped
        }
      }
    });
    const nsDefs = new Map<string, NamespaceDefinition>([['kx', def]]);
    expect(extractIndexedListFields(nsDefs)).toEqual([
      { namespace: 'kx', type: 'Item', field: 'values' }
    ]);
  });

  it('returns [] for a hand-crafted namespace def with no `types` (bypassed defineNamespace)', () => {
    const nsDefs = new Map<string, NamespaceDefinition>([
      ['hand', { namespace: 'hand', install: (): void => {} }]
    ]);
    expect(extractIndexedListFields(nsDefs)).toEqual([]);
  });
});
